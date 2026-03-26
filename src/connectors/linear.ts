import type { Connector, SyncResult } from "./types";
import type { TraulDB } from "../db/database";
import { type TraulConfig, getSyncStartTimestamp } from "../lib/config";
import * as log from "../lib/logger";

const LINEAR_API = "https://api.linear.app/graphql";

async function gql<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    throw new Error(`Linear API ${resp.status}: ${await resp.text()}`);
  }
  const json = (await resp.json()) as { data: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  return json.data;
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  state: { name: string } | null;
  assignee: { id: string; name: string; displayName: string } | null;
  creator: { id: string; name: string; displayName: string } | null;
  team: { id: string; name: string; key: string } | null;
  project: { id: string; name: string } | null;
  labels: { nodes: Array<{ name: string }> };
  priority: number;
  comments: {
    nodes: Array<{
      id: string;
      body: string;
      createdAt: string;
      user: { id: string; name: string; displayName: string } | null;
    }>;
  };
}

interface IssuesPage {
  issues: {
    nodes: LinearIssue[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

function buildIssuesQuery(opts: { hasTeam: boolean; hasDate: boolean }): string {
  const vars = ["$after: String"];
  const filters: string[] = [];
  if (opts.hasDate) {
    vars.push("$updatedAfter: DateTimeOrDuration");
    filters.push("updatedAt: { gte: $updatedAfter }");
  }
  if (opts.hasTeam) {
    vars.push("$teamId: String");
    filters.push("team: { id: { eq: $teamId } }");
  }
  const filterBlock = filters.length > 0 ? `filter: { ${filters.join("\n        ")} }` : "";
  return `
  query Issues(${vars.join(", ")}) {
    issues(
      first: 50
      after: $after
      ${filterBlock}
      orderBy: updatedAt
    ) {
      nodes {
        id identifier title description createdAt updatedAt
        state { name }
        assignee { id name displayName }
        creator { id name displayName }
        team { id name key }
        project { id name }
        labels { nodes { name } }
        priority
        comments { nodes { id body createdAt user { id name displayName } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

const TEAMS_QUERY = `
  query Teams {
    teams { nodes { id name key } }
  }
`;

function priorityLabel(p: number): string {
  return ["None", "Urgent", "High", "Medium", "Low"][p] ?? "None";
}

function issueContent(issue: LinearIssue): string {
  const parts: string[] = [`[${issue.identifier}] ${issue.title}`];
  if (issue.state) parts.push(`Status: ${issue.state.name}`);
  parts.push(`Priority: ${priorityLabel(issue.priority)}`);
  if (issue.labels.nodes.length) {
    parts.push(`Labels: ${issue.labels.nodes.map((l) => l.name).join(", ")}`);
  }
  if (issue.assignee) parts.push(`Assignee: ${issue.assignee.displayName}`);
  if (issue.description) {
    const desc = issue.description.length > 2000
      ? issue.description.slice(0, 2000) + "..."
      : issue.description;
    parts.push("", desc);
  }
  return parts.join("\n");
}

async function syncWorkspace(
  db: TraulDB,
  config: TraulConfig,
  apiKey: string,
  workspaceName: string,
  teamFilters: string[],
  result: SyncResult,
  contactCache: Map<string, string>,
): Promise<void> {
  async function ensureContact(user: { id: string; name: string; displayName: string }): Promise<string> {
    const cached = contactCache.get(user.id);
    if (cached) return cached;

    const existing = await db.getContactBySourceId("linear", user.id);
    if (!existing) {
      const contactId = await db.upsertContact(user.displayName || user.name);
      await db.upsertContactIdentity({
        contactId,
        source: "linear",
        sourceUserId: user.id,
        username: user.name,
        displayName: user.displayName,
      });
      result.contactsAdded++;
    }

    const name = user.displayName || user.name;
    contactCache.set(user.id, name);
    return name;
  }

  // Resolve teams to sync
  let teamIds: string[] = [];
  if (teamFilters.length > 0) {
    const data = await gql<{ teams: { nodes: Array<{ id: string; name: string; key: string }> } }>(apiKey, TEAMS_QUERY);
    for (const filter of teamFilters) {
      const team = data.teams.nodes.find(
        (t) => t.key === filter || t.name === filter || t.id === filter
      );
      if (team) {
        teamIds.push(team.id);
      } else {
        log.warn(`Linear team not found: ${filter} (workspace: ${workspaceName})`);
      }
    }
  }

  const syncStartTs = getSyncStartTimestamp(config);
  const syncStartDate = syncStartTs !== "0"
    ? new Date(parseInt(syncStartTs) * 1000).toISOString()
    : undefined;

  const passes = teamIds.length > 0 ? teamIds : [undefined];

  for (const teamId of passes) {
    const cursorKey = `${workspaceName}:${teamId ? `team:${teamId}` : "all"}`;
    const lastSync = await db.getSyncCursor("linear", cursorKey);
    // If sync_start is earlier than cursor, backfill from sync_start
    let updatedAfter = lastSync ?? syncStartDate;
    if (lastSync && syncStartDate && syncStartDate < lastSync) {
      updatedAfter = syncStartDate;
    }

    let after: string | null = null;
    let latestUpdated: string | null = null;
    let pageCount = 0;

    do {
      const query = buildIssuesQuery({ hasTeam: !!teamId, hasDate: !!updatedAfter });
      const variables: Record<string, unknown> = { after };
      if (updatedAfter) variables.updatedAfter = updatedAfter;
      if (teamId) variables.teamId = teamId;

      const data = await gql<IssuesPage>(apiKey, query, variables);
      const { nodes, pageInfo } = data.issues;

      for (const issue of nodes) {
        const channelName = issue.project
          ? `${issue.team?.key ?? "LIN"} / ${issue.project.name}`
          : issue.team?.name ?? "Linear";

        if (issue.creator) await ensureContact(issue.creator);
        if (issue.assignee) await ensureContact(issue.assignee);

        await db.upsertMessage({
          source: "linear",
          source_id: `issue:${issue.id}`,
          channel_name: channelName,
          thread_id: undefined,
          author_name: issue.creator
            ? issue.creator.displayName || issue.creator.name
            : undefined,
          content: issueContent(issue),
          sent_at: Math.floor(new Date(issue.createdAt).getTime() / 1000),
          metadata: JSON.stringify({
            identifier: issue.identifier,
            state: issue.state?.name,
            priority: issue.priority,
            assignee: issue.assignee?.displayName,
            labels: issue.labels.nodes.map((l) => l.name),
            updatedAt: issue.updatedAt,
          }),
        });
        result.messagesAdded++;

        for (const comment of issue.comments.nodes) {
          if (comment.user) await ensureContact(comment.user);

          await db.upsertMessage({
            source: "linear",
            source_id: `comment:${comment.id}`,
            channel_name: channelName,
            thread_id: `issue:${issue.id}`,
            author_name: comment.user
              ? comment.user.displayName || comment.user.name
              : undefined,
            content: comment.body,
            sent_at: Math.floor(new Date(comment.createdAt).getTime() / 1000),
          });
          result.messagesAdded++;
        }

        if (!latestUpdated || issue.updatedAt > latestUpdated) {
          latestUpdated = issue.updatedAt;
        }
      }

      pageCount++;
      log.info(`  [${workspaceName}] Page ${pageCount}: ${nodes.length} issues`);
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after);

    if (latestUpdated) {
      await db.setSyncCursor("linear", cursorKey, latestUpdated);
    }
  }
}

export const linearConnector: Connector = {
  defaultInterval: 600,
  hasCredentials: (config) => !!config.linear.api_key,
  name: "linear",

  async sync(db: TraulDB, config: TraulConfig): Promise<SyncResult> {
    const result: SyncResult = { messagesAdded: 0, messagesUpdated: 0, contactsAdded: 0 };
    const contactCache = new Map<string, string>();

    // Build workspace list: explicit workspaces + legacy single api_key
    const workspaces: Array<{ name: string; api_key: string; teams: string[] }> = [
      ...config.linear.workspaces,
    ];

    // Add legacy single key if it's not already covered by a workspace
    if (config.linear.api_key && !workspaces.some((w) => w.api_key === config.linear.api_key)) {
      workspaces.unshift({ name: "default", api_key: config.linear.api_key, teams: config.linear.teams });
    }

    if (workspaces.length === 0) {
      log.warn("Linear API key not configured.");
      log.warn("Set LINEAR_API_KEY or LINEAR_API_KEY_<WORKSPACE> env vars, or add linear config to ~/.config/traul/config.json");
      return result;
    }

    for (const ws of workspaces) {
      log.info(`Syncing Linear workspace: ${ws.name}`);
      await syncWorkspace(db, config, ws.api_key, ws.name, ws.teams, result, contactCache);
    }

    return result;
  },
};
