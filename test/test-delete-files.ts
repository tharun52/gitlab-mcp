import { describe, test } from "node:test";
import assert from "node:assert";
import { spawn } from "child_process";
import { MockGitLabServer, findMockServerPort } from "./utils/mock-gitlab-server.js";

const MOCK_TOKEN = "mock-token-delete-files";
const PROJECT_ID = "42";

const MOCK_COMMIT = {
  id: "abc123",
  short_id: "abc123",
  title: "Delete files",
  author_name: "Test User",
  author_email: "test@example.com",
  authored_date: "2024-01-01T00:00:00.000Z",
  committer_name: "Test User",
  committer_email: "test@example.com",
  committed_date: "2024-01-01T00:00:00.000Z",
  created_at: "2024-01-01T00:00:00.000Z",
  message: "Delete files",
  parent_ids: [],
  web_url: "https://gitlab.example.com/project/-/commit/abc123",
};

async function callDeleteFiles(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", ["build/index.js"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let output = "";
    let errorOutput = "";
    proc.stdout?.on("data", (d: Buffer) => (output += d));
    proc.stderr?.on("data", (d: Buffer) => (errorOutput += d));

    proc.on("close", code => {
      if (code !== 0) {
        return reject(new Error(`Process exited with code ${code}: ${errorOutput}`));
      }

      const line = output.split("\n").find(l => l.startsWith("{"));
      if (!line) return reject(new Error("No JSON output found"));

      try {
        const response = JSON.parse(line);
        if (response.error) {
          reject(new Error(response.error?.message ?? String(response.error)));
        } else {
          const content = response.result?.content?.[0]?.text;
          resolve(content ? JSON.parse(content) : response.result);
        }
      } catch (e) {
        reject(e);
      }
    });

    proc.stdin?.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_files", arguments: args },
      }) + "\n"
    );
  });
}

describe("When delete_files is called", () => {
  test("should send delete actions for each file in a single commit", async () => {
    const mockPort = await findMockServerPort();
    const mockServer = new MockGitLabServer({ port: mockPort, validTokens: [MOCK_TOKEN] });
    let receivedBody: Record<string, unknown> | undefined;

    mockServer.addMockHandler("post", `/projects/${PROJECT_ID}/repository/commits`, (req, res) => {
      receivedBody = req.body as Record<string, unknown>;
      res.status(201).json(MOCK_COMMIT);
    });

    await mockServer.start();

    try {
      const result = await callDeleteFiles(
        {
          project_id: PROJECT_ID,
          branch: "main",
          files: ["src/old-file.ts", "docs/outdated.md"],
          commit_message: "Remove old files",
        },
        {
          GITLAB_API_URL: `${mockServer.getUrl()}/api/v4`,
          GITLAB_PERSONAL_ACCESS_TOKEN: MOCK_TOKEN,
        }
      );

      const actions = receivedBody?.actions as Array<{ action: string; file_path: string }>;
      assert.strictEqual(actions.length, 2);
      assert.ok(actions.every(a => a.action === "delete"), "All actions should be 'delete'");
      assert.deepStrictEqual(
        actions.map(a => a.file_path),
        ["src/old-file.ts", "docs/outdated.md"]
      );
      assert.strictEqual(receivedBody?.branch, "main");
      assert.strictEqual(receivedBody?.commit_message, "Remove old files");
      assert.strictEqual((result as { id: string }).id, MOCK_COMMIT.id);
    } finally {
      await mockServer.stop();
    }
  });

  test("should send a single delete action when one file is given", async () => {
    const mockPort = await findMockServerPort();
    const mockServer = new MockGitLabServer({ port: mockPort, validTokens: [MOCK_TOKEN] });
    let receivedBody: Record<string, unknown> | undefined;

    mockServer.addMockHandler("post", `/projects/${PROJECT_ID}/repository/commits`, (req, res) => {
      receivedBody = req.body as Record<string, unknown>;
      res.status(201).json(MOCK_COMMIT);
    });

    await mockServer.start();

    try {
      await callDeleteFiles(
        {
          project_id: PROJECT_ID,
          branch: "main",
          files: ["README.md"],
          commit_message: "Delete README",
        },
        {
          GITLAB_API_URL: `${mockServer.getUrl()}/api/v4`,
          GITLAB_PERSONAL_ACCESS_TOKEN: MOCK_TOKEN,
        }
      );

      const actions = receivedBody?.actions as Array<{ action: string; file_path: string }>;
      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].action, "delete");
      assert.strictEqual(actions[0].file_path, "README.md");
    } finally {
      await mockServer.stop();
    }
  });
});
