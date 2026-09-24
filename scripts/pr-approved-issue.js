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

/**
 * Enforce that external PRs link an approved issue assigned to the author.
 *
 * - On `opened`, an "Approved issue link" section is added to the description
 *   if it is missing.
 * - On every run, HTML comments are stripped and the description is scanned for
 *   issue references (`#xxx`, `owner/repo#xxx` or a full issue URL). The PR
 *   passes when at least one referenced issue exists in this repo and has the
 *   PR author as an assignee.
 * - When the check fails and the PR is not a draft, the PR is converted to a
 *   draft. Draft PRs are never automatically converted out of draft; the author
 *   can mark the PR "Ready for review" themselves once ready.
 * - A single sticky comment is kept up to date with the result.
 *
 * Maintainers, collaborators and bots are skipped by the workflow `if:`.
 */

const POLICY_DOC_URL =
  "https://github.com/keras-team/shared-workflows/blob/main/docs/pr_policy.md";
const SECTION_HEADING = "## Approved issue link";
const SECTION_TEMPLATE = `${SECTION_HEADING}
<!--- Link the approved issue that is assigned to you, e.g. "Fixes #xxx".
      An issue must be assigned to you and linked here before this PR can be
      marked "Ready for review". See ${POLICY_DOC_URL} -->

`;
const COMMENT_MARKER = "<!-- pr-approved-issue-check -->";
const BYPASS_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];
// Historical RFC announcement issue in keras-team/keras that was linked in PR templates.
const IGNORED_REPO_ISSUES = {
  "keras-team/keras": new Set([23601]),
};

module.exports = async function prApprovedIssue({ github, context, core }) {
  const pr = context.payload.pull_request;
  if (!pr) {
    core.info("Not a pull request payload.");
    return;
  }

  const { owner, repo } = context.repo;
  const action = context.payload.action;
  const author = pr.user.login;

  // Defence in depth: the workflow `if:` already filters these out.
  if (
    pr.user.type === "Bot" ||
    author.toLowerCase().endsWith("[bot]") ||
    BYPASS_ASSOCIATIONS.includes(pr.author_association)
  ) {
    core.info(`Skipping #${pr.number}: ${author} is ${pr.author_association}.`);
    return;
  }

  let body = pr.body || "";
  let isDraft = pr.draft;

  // 1. Find issues referenced in the description that are assigned to the author.
  const referenced = findIssueNumbers(body, owner, repo);
  const assigned = [];
  const notAssigned = [];
  for (const number of referenced) {
    try {
      const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: number });
      if (issue.pull_request) continue; // A PR reference, not an issue.
      const assignees = (issue.assignees || []).map((a) => a.login.toLowerCase());
      (assignees.includes(author.toLowerCase()) ? assigned : notAssigned).push(number);
    } catch (err) {
      core.info(`Could not fetch issue #${number}: ${err.message}`);
    }
  }
  const passed = assigned.length > 0;

  // 2. On open: if the check failed, ensure the description has the "Approved issue link" section.
  if (!passed && action === "opened" && !body.includes(SECTION_HEADING)) {
    body = SECTION_TEMPLATE + body;
    await github.rest.pulls.update({ owner, repo, pull_number: pr.number, body });
    core.info(`Added "${SECTION_HEADING}" section to #${pr.number}.`);
  }

  // 3. Convert to draft if the check failed and the PR is not already a draft.
  // Never automatically mark a draft PR as ready for review.
  if (!passed && !isDraft) {
    isDraft = await convertToDraft(github, core, pr);
  }

  // 4. Report via a sticky comment and the job status.
  const message = passed
    ? [
        `✅ Approved issue check passed: ${assigned.map((n) => `#${n}`).join(", ")} ` +
          `is assigned to @${author}.`,
        isDraft
          ? "You can mark this PR **Ready for review** when it is ready."
          : "This PR is **Ready for review**.",
      ]
    : [
        `❌ Approved issue check failed. This PR ${isDraft ? "stays" : "must stay"} in **draft** until ` +
          "it links an approved issue that is assigned to you.",
        "",
        `See the [Keras Pull Request Policy](${POLICY_DOC_URL}). To fix this:`,
        "1. Find or open an issue for this change and ask a maintainer to approve it and assign it to you.",
        `2. Link it under the "${SECTION_HEADING.replace("## ", "")}" section of this PR's description, e.g. \`Fixes #xxx\`.`,
        "3. Once this check passes, mark the PR **Ready for review** when it is ready.",
        "",
        notAssigned.length
          ? `Referenced issue(s) not assigned to @${author}: ${notAssigned.map((n) => `#${n}`).join(", ")}.`
          : "No issue reference was found in the description.",
      ];
  await upsertComment(github, owner, repo, pr.number, message.join("\n"));

  if (!passed) {
    core.setFailed(`No approved issue assigned to ${author} is linked in #${pr.number}.`);
  }
};

/** Collect issue numbers referenced in `body` (excluding HTML comments) that belong to this repo. */
function findIssueNumbers(body, owner, repo) {
  // Strip HTML comments so placeholders like <!-- Fixes #123 --> are never matched.
  const uncommented = body.replace(/<!--[\s\S]*?-->/g, "");
  const repoKey = `${owner}/${repo}`.toLowerCase();
  const ignored = IGNORED_REPO_ISSUES[repoKey] || new Set();

  const escaped = `${owner}/${repo}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`https?://github\\.com/${escaped}/issues/(\\d+)`, "gi"),
    new RegExp(`(?:^|[^\\w/])${escaped}#(\\d+)`, "gi"),
    // Bare `#123`, but not `owner/repo#123` of some other repo.
    /(?:^|[^\w/])#(\d+)\b/g,
  ];
  const numbers = new Set();
  for (const pattern of patterns) {
    for (const match of uncommented.matchAll(pattern)) {
      const num = Number(match[1]);
      if (!ignored.has(num)) {
        numbers.add(num);
      }
    }
  }
  return [...numbers];
}

async function convertToDraft(github, core, pr) {
  try {
    await github.graphql(
      `mutation($id: ID!) {
        convertPullRequestToDraft(input: {pullRequestId: $id}) {
          pullRequest { isDraft }
        }
      }`,
      { id: pr.node_id }
    );
    core.info(`Converted #${pr.number} to draft.`);
    return true;
  } catch (err) {
    warnDraftToggleFailed(core, `convert #${pr.number} to draft`, err);
    return pr.draft;
  }
}

function warnDraftToggleFailed(core, what, err) {
  const lines = [`Could not ${what}: ${err.message}`];
  if (/not accessible by integration/i.test(err.message)) {
    lines.push("Toggling draft state needs `contents: write` and `pull-requests: write`.");
  }
  core.warning(lines.join("\n"));
}

async function upsertComment(github, owner, repo, issue_number, text) {
  const body = `${COMMENT_MARKER}\n${text}`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body && c.body.startsWith(COMMENT_MARKER));
  if (existing) {
    if (existing.body !== body) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    }
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number, body });
  }
}
