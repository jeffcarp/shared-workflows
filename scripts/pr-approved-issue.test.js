/**
 * @license
 * Copyright 2026 The Keras Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const prApprovedIssue = require('./pr-approved-issue.js');

describe('prApprovedIssue', () => {
  function createHarness({
    action = 'opened',
    pr = null,
    issuesByNumber = {},
    existingComments = [],
    graphqlError = null,
  }) {
    const infoMessages = [];
    const warningMessages = [];
    let failedMessage = null;
    const updatedPrs = [];
    const graphqlCalls = [];
    const createdComments = [];
    const updatedComments = [];

    const core = {
      info: (msg) => infoMessages.push(msg),
      warning: (msg) => warningMessages.push(msg),
      setFailed: (msg) => {
        failedMessage = msg;
      },
    };

    const github = {
      rest: {
        pulls: {
          update: async (params) => {
            updatedPrs.push(params);
          },
        },
        issues: {
          get: async ({ issue_number }) => {
            if (!(issue_number in issuesByNumber)) {
              throw new Error('Not Found');
            }
            return { data: issuesByNumber[issue_number] };
          },
          listComments: async () => ({ data: existingComments }),
          createComment: async (params) => {
            createdComments.push(params);
          },
          updateComment: async (params) => {
            updatedComments.push(params);
          },
        },
      },
      paginate: async (fn, params) => {
        const res = await fn(params);
        return res.data;
      },
      graphql: async (query, variables) => {
        graphqlCalls.push({ query, variables });
        if (graphqlError) {
          throw graphqlError;
        }
        return {};
      },
    };

    const context = {
      repo: { owner: 'keras-team', repo: 'keras-hub' },
      payload: {
        action,
        pull_request: pr,
      },
    };

    return {
      run: () => prApprovedIssue({ github, context, core }),
      getInfoMessages: () => infoMessages,
      getWarningMessages: () => warningMessages,
      getFailedMessage: () => failedMessage,
      getUpdatedPrs: () => updatedPrs,
      getGraphqlCalls: () => graphqlCalls,
      getCreatedComments: () => createdComments,
      getUpdatedComments: () => updatedComments,
    };
  }

  it('ignores non-pull-request payloads safely', async () => {
    const harness = createHarness({ pr: null });
    await harness.run();
    assert.strictEqual(harness.getFailedMessage(), null);
    assert.ok(harness.getInfoMessages().includes('Not a pull request payload.'));
  });

  it('skips bots and bypassed author associations (OWNER, MEMBER, COLLABORATOR)', async () => {
    for (const [type, association] of [
      ['Bot', 'NONE'],
      ['User', 'OWNER'],
      ['User', 'MEMBER'],
      ['User', 'COLLABORATOR'],
    ]) {
      const harness = createHarness({
        pr: {
          number: 10,
          node_id: 'PR_10',
          draft: false,
          author_association: association,
          user: { login: 'maintainer-or-bot', type },
          body: 'No issue link needed',
        },
      });
      await harness.run();
      assert.strictEqual(harness.getFailedMessage(), null);
      assert.strictEqual(harness.getGraphqlCalls().length, 0);
      assert.strictEqual(harness.getCreatedComments().length, 0);
    }
  });

  it('on opened: prepends Approved issue link section, converts non-draft PR to draft, posts comment, and fails when no issue is linked', async () => {
    const harness = createHarness({
      action: 'opened',
      pr: {
        number: 42,
        node_id: 'PR_42',
        draft: false,
        author_association: 'NONE',
        user: { login: 'external-dev', type: 'User' },
        body: 'Here is my new feature.',
      },
    });

    await harness.run();

    // 1. Section added to PR description.
    assert.strictEqual(harness.getUpdatedPrs().length, 1);
    assert.ok(harness.getUpdatedPrs()[0].body.startsWith('## Approved issue link\n'));
    assert.ok(harness.getUpdatedPrs()[0].body.endsWith('Here is my new feature.'));

    // 2. Converted to draft once on opened (and not called a second time).
    assert.strictEqual(harness.getGraphqlCalls().length, 1);
    assert.ok(harness.getGraphqlCalls()[0].query.includes('convertPullRequestToDraft'));
    assert.deepStrictEqual(harness.getGraphqlCalls()[0].variables, { id: 'PR_42' });

    // 3. Sticky comment created.
    assert.strictEqual(harness.getCreatedComments().length, 1);
    assert.ok(harness.getCreatedComments()[0].body.startsWith('<!-- pr-approved-issue-check -->'));
    assert.ok(harness.getCreatedComments()[0].body.includes('No issue reference was found in the description.'));

    // 4. Workflow marked failed.
    assert.strictEqual(
      harness.getFailedMessage(),
      'No approved issue assigned to external-dev is linked in #42.'
    );
  });

  it('on opened when section already exists and PR is already draft: skips body update and draft conversion', async () => {
    const harness = createHarness({
      action: 'opened',
      pr: {
        number: 43,
        node_id: 'PR_43',
        draft: true,
        author_association: 'NONE',
        user: { login: 'external-dev', type: 'User' },
        body: '## Approved issue link\n\nStill working on it.',
      },
    });

    await harness.run();

    assert.strictEqual(harness.getUpdatedPrs().length, 0);
    assert.strictEqual(harness.getGraphqlCalls().length, 0);
    assert.notStrictEqual(harness.getFailedMessage(), null);
  });

  it('passes check and marks draft PR ready for review when an issue assigned to the author is referenced', async () => {
    const harness = createHarness({
      action: 'edited',
      pr: {
        number: 42,
        node_id: 'PR_42',
        draft: true,
        author_association: 'FIRST_TIME_CONTRIBUTOR',
        user: { login: 'External-Dev', type: 'User' },
        body: '## Approved issue link\nFixes #123\nAlso see keras-team/keras-hub#124 and https://github.com/keras-team/keras-hub/issues/125',
      },
      issuesByNumber: {
        123: { number: 123, assignees: [{ login: 'external-dev' }] },
        124: { number: 124, assignees: [{ login: 'someone-else' }] },
        125: { number: 125, assignees: [{ login: 'EXTERNAL-DEV' }] },
      },
    });

    await harness.run();

    // Marked ready for review via GraphQL.
    assert.strictEqual(harness.getGraphqlCalls().length, 1);
    assert.ok(harness.getGraphqlCalls()[0].query.includes('markPullRequestReadyForReview'));

    // Sticky comment reports passed issues #125, #123 (matched in pattern order: URL, owner/repo#, bare #).
    assert.strictEqual(harness.getCreatedComments().length, 1);
    const commentBody = harness.getCreatedComments()[0].body;
    assert.ok(commentBody.includes('✅ Approved issue check passed: #125, #123 is assigned to @External-Dev.'));
    assert.ok(commentBody.includes('This PR is **Ready for review**.'));

    // Check succeeded.
    assert.strictEqual(harness.getFailedMessage(), null);
  });

  it('ignores references to other repositories and pull request numbers', async () => {
    const harness = createHarness({
      action: 'edited',
      pr: {
        number: 50,
        node_id: 'PR_50',
        draft: true,
        author_association: 'NONE',
        user: { login: 'contributor', type: 'User' },
        body: 'Fixes other-org/other-repo#100 and https://github.com/other-org/other-repo/issues/101 and #200',
      },
      issuesByNumber: {
        100: { number: 100, assignees: [{ login: 'contributor' }] },
        101: { number: 101, assignees: [{ login: 'contributor' }] },
        // #200 is a PR, not an issue.
        200: { number: 200, pull_request: {}, assignees: [{ login: 'contributor' }] },
      },
    });

    await harness.run();

    assert.strictEqual(harness.getGraphqlCalls().length, 0);
    assert.notStrictEqual(harness.getFailedMessage(), null);
    assert.ok(
      harness.getCreatedComments()[0].body.includes('No issue reference was found in the description.')
    );
  });

  it('converts non-draft PR to draft when edited to reference only unassigned issues', async () => {
    const harness = createHarness({
      action: 'edited',
      pr: {
        number: 55,
        node_id: 'PR_55',
        draft: false,
        author_association: 'CONTRIBUTOR',
        user: { login: 'contributor', type: 'User' },
        body: '## Approved issue link\nFixes #300 and #999',
      },
      issuesByNumber: {
        300: { number: 300, assignees: [{ login: 'other-user' }] },
        // #999 does not exist (throws Not Found).
      },
    });

    await harness.run();

    assert.strictEqual(harness.getGraphqlCalls().length, 1);
    assert.ok(harness.getGraphqlCalls()[0].query.includes('convertPullRequestToDraft'));
    assert.ok(
      harness
        .getCreatedComments()[0]
        .body.includes('Referenced issue(s) not assigned to @contributor: #300.')
    );
    assert.notStrictEqual(harness.getFailedMessage(), null);
  });

  it('updates existing sticky comment when content changes and avoids API call when unchanged', async () => {
    const existingBody =
      '<!-- pr-approved-issue-check -->\n' +
      '✅ Approved issue check passed: #123 is assigned to @contributor.\n' +
      'This PR is **Ready for review**.';

    // 1. Unchanged comment body -> no create or update call.
    const unchangedHarness = createHarness({
      action: 'edited',
      pr: {
        number: 60,
        node_id: 'PR_60',
        draft: false,
        author_association: 'NONE',
        user: { login: 'contributor', type: 'User' },
        body: 'Fixes #123',
      },
      issuesByNumber: {
        123: { number: 123, assignees: [{ login: 'contributor' }] },
      },
      existingComments: [{ id: 777, body: existingBody }],
    });

    await unchangedHarness.run();
    assert.strictEqual(unchangedHarness.getCreatedComments().length, 0);
    assert.strictEqual(unchangedHarness.getUpdatedComments().length, 0);

    // 2. Changed comment body -> updates existing comment.
    const changedHarness = createHarness({
      action: 'edited',
      pr: {
        number: 60,
        node_id: 'PR_60',
        draft: false,
        author_association: 'NONE',
        user: { login: 'contributor', type: 'User' },
        body: 'Fixes #456',
      },
      issuesByNumber: {
        456: { number: 456, assignees: [{ login: 'contributor' }] },
      },
      existingComments: [{ id: 777, body: existingBody }],
    });

    await changedHarness.run();
    assert.strictEqual(changedHarness.getCreatedComments().length, 0);
    assert.strictEqual(changedHarness.getUpdatedComments().length, 1);
    assert.strictEqual(changedHarness.getUpdatedComments()[0].comment_id, 777);
    assert.ok(changedHarness.getUpdatedComments()[0].body.includes('#456'));
  });

  it('logs warning with permissions hint when GraphQL draft state toggle fails', async () => {
    const harness = createHarness({
      action: 'edited',
      pr: {
        number: 70,
        node_id: 'PR_70',
        draft: true,
        author_association: 'NONE',
        user: { login: 'contributor', type: 'User' },
        body: 'Fixes #123',
      },
      issuesByNumber: {
        123: { number: 123, assignees: [{ login: 'contributor' }] },
      },
      graphqlError: new Error('Resource not accessible by integration'),
    });

    await harness.run();

    assert.strictEqual(harness.getWarningMessages().length, 1);
    assert.ok(
      harness
        .getWarningMessages()[0]
        .includes('Toggling draft state needs `contents: write` and `pull-requests: write`.')
    );
    assert.ok(
      harness
        .getCreatedComments()[0]
        .body.includes('Could not mark this PR as ready automatically; please mark it **Ready for review**.')
    );
  });
});
