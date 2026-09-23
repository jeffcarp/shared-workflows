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

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const autoAssign = require('./auto-assignment.js');

describe('autoAssign', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  function createHarness({ env = {}, payload = {} }) {
    const infoMessages = [];
    const addedAssignees = [];
    const requestedReviewers = [];

    const core = {
      info: (msg) => infoMessages.push(msg),
    };

    const github = {
      rest: {
        issues: {
          addAssignees: async (params) => {
            addedAssignees.push(params);
          },
        },
        pulls: {
          requestReviewers: async (params) => {
            requestedReviewers.push(params);
          },
        },
      },
    };

    const context = {
      repo: { owner: 'keras-team', repo: 'keras-hub' },
      payload,
    };

    ['CONFIG_ISSUE_ASSIGNEES', 'CONFIG_PR_ASSIGNEES', 'CONFIG_PR_REVIEWERS'].forEach((k) => {
      if (k in env) {
        process.env[k] = env[k];
      } else {
        delete process.env[k];
      }
    });

    return {
      run: () => autoAssign({ github, context, core }),
      getInfoMessages: () => infoMessages,
      getAddedAssignees: () => addedAssignees,
      getRequestedReviewers: () => requestedReviewers,
    };
  }

  it('assigns an issue on rotation based on issue number', async () => {
    const harness = createHarness({
      env: {
        CONFIG_ISSUE_ASSIGNEES: 'maitry63,mrinalghoshh,dhantule',
        CONFIG_PR_REVIEWERS: 'laxmareddyp,JyotinderSingh',
      },
      payload: { issue: { number: 10, user: { login: 'some-user' } } },
    });

    await harness.run();
    assert.strictEqual(harness.getAddedAssignees().length, 1);
    assert.deepStrictEqual(harness.getAddedAssignees()[0], {
      owner: 'keras-team',
      repo: 'keras-hub',
      issue_number: 10,
      assignees: ['mrinalghoshh'], // 10 % 3 === 1
    });
    assert.strictEqual(harness.getRequestedReviewers().length, 0);
  });

  it('requests PR reviews from all configured pr_reviewers', async () => {
    const harness = createHarness({
      env: {
        CONFIG_ISSUE_ASSIGNEES: 'maitry63,mrinalghoshh,dhantule',
        CONFIG_PR_REVIEWERS: 'laxmareddyp,JyotinderSingh',
      },
      payload: {
        pull_request: { number: 2971, user: { login: 'contributor' } },
      },
    });

    await harness.run();
    assert.strictEqual(harness.getRequestedReviewers().length, 1);
    assert.deepStrictEqual(harness.getRequestedReviewers()[0], {
      owner: 'keras-team',
      repo: 'keras-hub',
      pull_number: 2971,
      reviewers: ['laxmareddyp', 'JyotinderSingh'],
    });
    assert.strictEqual(harness.getAddedAssignees().length, 0);
  });

  it('filters out the PR author from pr_reviewers to avoid GitHub API 422 error', async () => {
    const harness = createHarness({
      env: {
        CONFIG_PR_REVIEWERS: 'laxmareddyp,JyotinderSingh',
      },
      payload: {
        pull_request: { number: 3000, user: { login: 'JyotinderSingh' } },
      },
    });

    await harness.run();
    assert.strictEqual(harness.getRequestedReviewers().length, 1);
    assert.deepStrictEqual(harness.getRequestedReviewers()[0], {
      owner: 'keras-team',
      repo: 'keras-hub',
      pull_number: 3000,
      reviewers: ['laxmareddyp'],
    });
    assert.ok(
      harness
        .getInfoMessages()
        .includes('Skipping PR author JyotinderSingh from review requests.')
    );
  });

  it('assigns a PR assignee on rotation when pr_assignees is configured', async () => {
    const harness = createHarness({
      env: {
        CONFIG_PR_ASSIGNEES: 'userA,userB',
      },
      payload: {
        pull_request: { number: 43, user: { login: 'contributor' } },
      },
    });

    await harness.run();
    assert.strictEqual(harness.getAddedAssignees().length, 1);
    assert.deepStrictEqual(harness.getAddedAssignees()[0], {
      owner: 'keras-team',
      repo: 'keras-hub',
      issue_number: 43,
      assignees: ['userB'], // 43 % 2 === 1
    });
  });

  it('assigns a PR assignee and requests reviews when both pr_assignees and pr_reviewers are configured', async () => {
    const harness = createHarness({
      env: {
        CONFIG_PR_ASSIGNEES: 'userA,userB',
        CONFIG_PR_REVIEWERS: 'laxmareddyp,JyotinderSingh',
      },
      payload: {
        pull_request: { number: 43, user: { login: 'contributor' } },
      },
    });

    await harness.run();
    assert.strictEqual(harness.getAddedAssignees().length, 1);
    assert.deepStrictEqual(harness.getAddedAssignees()[0], {
      owner: 'keras-team',
      repo: 'keras-hub',
      issue_number: 43,
      assignees: ['userB'], // 43 % 2 === 1
    });
    assert.strictEqual(harness.getRequestedReviewers().length, 1);
    assert.deepStrictEqual(harness.getRequestedReviewers()[0], {
      owner: 'keras-team',
      repo: 'keras-hub',
      pull_number: 43,
      reviewers: ['laxmareddyp', 'JyotinderSingh'],
    });
  });

  it('makes no API calls when the PR author is the only configured reviewer', async () => {
    const harness = createHarness({
      env: {
        CONFIG_PR_REVIEWERS: 'JyotinderSingh',
      },
      payload: {
        pull_request: { number: 3001, user: { login: 'JyotinderSingh' } },
      },
    });

    await harness.run();
    assert.strictEqual(harness.getAddedAssignees().length, 0);
    assert.strictEqual(harness.getRequestedReviewers().length, 0);
    assert.ok(
      harness
        .getInfoMessages()
        .includes('Skipping PR author JyotinderSingh from review requests.')
    );
    assert.ok(
      harness
        .getInfoMessages()
        .includes('No assignees or reviewers to apply for this event.')
    );
  });

  it('does nothing when no assignees or reviewers are configured for a PR', async () => {
    const harness = createHarness({
      env: {
        CONFIG_ISSUE_ASSIGNEES: 'maitry63,mrinalghoshh,dhantule',
      },
      payload: {
        pull_request: { number: 50, user: { login: 'contributor' } },
      },
    });

    await harness.run();
    assert.strictEqual(harness.getAddedAssignees().length, 0);
    assert.strictEqual(harness.getRequestedReviewers().length, 0);
    assert.ok(
      harness
        .getInfoMessages()
        .includes('No assignees or reviewers to apply for this event.')
    );
  });
});
