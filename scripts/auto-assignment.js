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
 * Automatically assigns issues/PRs on rotation and/or requests PR reviews.
 *
 * @param {!object} params
 * @param {!object} params.github - GitHub octokit client.
 * @param {!object} params.context - GitHub actions context.
 * @param {!object} params.core - Actions core library for logging.
 */
module.exports = async function autoAssign({ github, context, core }) {
  let issueNumber;
  let assigneesList = [];
  let reviewersList = [];

  const isIssue = Boolean(context.payload.issue && !context.payload.pull_request);
  const isPr = Boolean(context.payload.pull_request || context.payload.number);

  if (isIssue) {
    const raw = process.env.CONFIG_ISSUE_ASSIGNEES || '';
    assigneesList = raw.split(',').map(s => s.trim()).filter(Boolean);
    issueNumber = context.payload.issue.number;
  } else if (isPr) {
    const rawAssignees = process.env.CONFIG_PR_ASSIGNEES || '';
    assigneesList = rawAssignees.split(',').map(s => s.trim()).filter(Boolean);

    const rawReviewers = process.env.CONFIG_PR_REVIEWERS || '';
    const prAuthor = (context.payload.pull_request?.user?.login || '').toLowerCase();
    reviewersList = rawReviewers
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(u => u.toLowerCase() !== prAuthor);

    issueNumber = context.payload.pull_request
      ? context.payload.pull_request.number
      : context.payload.number;
  }

  if (!assigneesList.length && !reviewersList.length) {
    core.info('No assignees or reviewers configured for this event type.');
    return;
  }

  if (assigneesList.length > 0) {
    core.info(`Assignee list for target #${issueNumber}: ${assigneesList.join(', ')}`);
    const selection = issueNumber % assigneesList.length;
    const chosenAssignee = assigneesList[selection];

    core.info(`Assigning #${issueNumber} to ${chosenAssignee}`);
    await github.rest.issues.addAssignees({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issueNumber,
      assignees: [chosenAssignee],
    });
  }

  if (reviewersList.length > 0) {
    core.info(`Requesting reviews for PR #${issueNumber} from: ${reviewersList.join(', ')}`);
    await github.rest.pulls.requestReviewers({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: issueNumber,
      reviewers: reviewersList,
    });
  }
};
