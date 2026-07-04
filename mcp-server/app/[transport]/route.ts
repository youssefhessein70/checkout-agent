import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function getRepoFullName() {
  return process.env.GITHUB_REPO || 'youssefhessein70/checkout-agent';
}

function getWorkflowFile() {
  return process.env.GITHUB_WORKFLOW_FILE || 'checkout-agent.yml';
}

function getBranch() {
  return process.env.GITHUB_BRANCH || 'main';
}

function checkAuth(req: Request) {
  const expected = process.env.MCP_API_KEY;

  if (!expected) return false;

  const authorization = req.headers.get('authorization') || '';
  const bearerToken = authorization.replace(/^Bearer\s+/i, '').trim();
  const apiKey = req.headers.get('x-api-key') || '';

  return bearerToken === expected || apiKey === expected;
}

async function githubRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
  } = {}
) {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error('Missing GITHUB_TOKEN environment variable');
  }

  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && String(value) !== '') {
      query.set(key, String(value));
    }
  }

  const url = `https://api.github.com${path}${query.toString() ? `?${query.toString()}` : ''}`;

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 1200)}`);
  }

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function textResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      }
    ]
  };
}

const mcpHandler = createMcpHandler(
  (server) => {
    server.tool(
      'runCheckoutAgent',
      'Trigger the checkout-agent GitHub Actions workflow.',
      {
        only_store: z
          .string()
          .optional()
          .describe('Store name to run. Empty string runs all active stores.'),
        ref: z.string().optional().default(getBranch())
      },
      async ({ only_store = '', ref = getBranch() }) => {
        const repo = getRepoFullName();
        const workflow = getWorkflowFile();

        await githubRequest(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
          method: 'POST',
          body: {
            ref,
            inputs: {
              only_store: only_store || '',
              confirmed: 'true'
            }
          }
        });

        return textResult({
          ok: true,
          message: 'checkout-agent workflow dispatch accepted',
          repo,
          workflow,
          ref,
          only_store: only_store || ''
        });
      }
    );

    server.tool(
      'getLatestCheckoutRuns',
      'Get recent GitHub Actions workflow runs for checkout-agent.',
      {
        per_page: z.number().int().min(1).max(20).optional().default(5),
        branch: z.string().optional().default(getBranch()),
        event: z.string().optional()
      },
      async ({ per_page = 5, branch = getBranch(), event }) => {
        const repo = getRepoFullName();

        const data = await githubRequest(`/repos/${repo}/actions/runs`, {
          query: {
            per_page,
            branch,
            event
          }
        });

        const runs = (data?.workflow_runs || []).map((run: any) => ({
          id: run.id,
          name: run.name,
          event: run.event,
          status: run.status,
          conclusion: run.conclusion,
          workflow_id: run.workflow_id,
          head_branch: run.head_branch,
          created_at: run.created_at,
          updated_at: run.updated_at,
          html_url: run.html_url
        }));

        return textResult({
          ok: true,
          runs
        });
      }
    );

    server.tool(
      'getCheckoutRunJobs',
      'Get jobs and steps for a specific GitHub Actions workflow run.',
      {
        run_id: z.number().int().positive()
      },
      async ({ run_id }) => {
        const repo = getRepoFullName();

        const data = await githubRequest(`/repos/${repo}/actions/runs/${run_id}/jobs`);

        const jobs = (data?.jobs || []).map((job: any) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          started_at: job.started_at,
          completed_at: job.completed_at,
          html_url: job.html_url,
          steps: (job.steps || []).map((step: any) => ({
            name: step.name,
            status: step.status,
            conclusion: step.conclusion,
            number: step.number,
            started_at: step.started_at,
            completed_at: step.completed_at
          }))
        }));

        return textResult({
          ok: true,
          jobs
        });
      }
    );

    server.tool(
      'getCheckoutRunArtifacts',
      'Get artifacts for a specific GitHub Actions workflow run.',
      {
        run_id: z.number().int().positive()
      },
      async ({ run_id }) => {
        const repo = getRepoFullName();

        const data = await githubRequest(`/repos/${repo}/actions/runs/${run_id}/artifacts`);

        const artifacts = (data?.artifacts || []).map((artifact: any) => ({
          id: artifact.id,
          name: artifact.name,
          size_in_bytes: artifact.size_in_bytes,
          expired: artifact.expired,
          created_at: artifact.created_at,
          expires_at: artifact.expires_at,
          archive_download_url: artifact.archive_download_url
        }));

        return textResult({
          ok: true,
          artifacts
        });
      }
    );
  },
  {},
  {
    basePath: '',
    verboseLogs: true
  }
);

async function authorized(req: Request) {
  if (!checkAuth(req)) {
    return new Response('Unauthorized', { status: 401 });
  }

  return mcpHandler(req);
}

export { authorized as GET, authorized as POST, authorized as DELETE };
