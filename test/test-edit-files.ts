import { describe, test } from "node:test";
import assert from "node:assert";
import { spawn } from "child_process";
import { MockGitLabServer, findMockServerPort } from "./utils/mock-gitlab-server.js";

const MOCK_TOKEN = "mock-token-edit-files";
const PROJECT_ID = "42";

const MOCK_COMMIT = {
  id: "def456",
  short_id: "def456",
  title: "Edit files",
  author_name: "Test User",
  author_email: "test@example.com",
  authored_date: "2024-01-01T00:00:00.000Z",
  committer_name: "Test User",
  committer_email: "test@example.com",
  committed_date: "2024-01-01T00:00:00.000Z",
  created_at: "2024-01-01T00:00:00.000Z",
  message: "Edit files",
  parent_ids: [],
  web_url: "https://gitlab.example.com/project/-/commit/def456",
};

function makeFileResponse(filePath: string, content: string) {
  return {
    file_name: filePath.split("/").pop(),
    file_path: filePath,
    size: content.length,
    encoding: "base64",
    content: Buffer.from(content).toString("base64"),
    content_sha256: "abc",
    ref: "main",
    blob_id: "blob1",
    commit_id: "commit1",
    last_commit_id: "commit1",
  };
}

async function callEditFiles(
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
        params: { name: "edit_files", arguments: args },
      }) + "\n"
    );
  });
}

describe("When edit_files is called", () => {
  test("should apply search-and-replace changes across multiple files in a single commit", async () => {
    const mockPort = await findMockServerPort();
    const mockServer = new MockGitLabServer({ port: mockPort, validTokens: [MOCK_TOKEN] });
    let receivedCommitBody: Record<string, unknown> | undefined;

    mockServer.addMockHandler(
      "get",
      `/projects/${PROJECT_ID}/repository/files/src%2Fconfig.ts`,
      (_req, res) => {
        res.status(200).json(makeFileResponse("src/config.ts", "const ENV = 'dev';\nconst PORT = 3000;\n"));
      }
    );
    mockServer.addMockHandler(
      "get",
      `/projects/${PROJECT_ID}/repository/files/README.md`,
      (_req, res) => {
        res.status(200).json(makeFileResponse("README.md", "# My Projet\n\nInstalation guide\n"));
      }
    );
    mockServer.addMockHandler("post", `/projects/${PROJECT_ID}/repository/commits`, (req, res) => {
      receivedCommitBody = req.body as Record<string, unknown>;
      res.status(201).json(MOCK_COMMIT);
    });

    await mockServer.start();

    try {
      const result = await callEditFiles(
        {
          project_id: PROJECT_ID,
          branch: "main",
          commit_message: "Fix config and typos",
          files: [
            {
              file_path: "src/config.ts",
              changes: [
                { search: "const ENV = 'dev';", replace: "const ENV = 'prod';" },
                { search: "const PORT = 3000;", replace: "const PORT = 8080;" },
              ],
            },
            {
              file_path: "README.md",
              changes: [
                { search: "# My Projet", replace: "# My Project" },
                { search: "Instalation guide", replace: "Installation guide" },
              ],
            },
          ],
        },
        {
          GITLAB_API_URL: `${mockServer.getUrl()}/api/v4`,
          GITLAB_PERSONAL_ACCESS_TOKEN: MOCK_TOKEN,
        }
      );

      const actions = receivedCommitBody?.actions as Array<{
        action: string;
        file_path: string;
        content: string;
      }>;

      assert.strictEqual(actions.length, 2);
      assert.ok(actions.every(a => a.action === "update"), "All actions should be 'update'");

      const configAction = actions.find(a => a.file_path === "src/config.ts")!;
      assert.ok(configAction.content.includes("const ENV = 'prod';"), "ENV should be prod");
      assert.ok(configAction.content.includes("const PORT = 8080;"), "PORT should be 8080");

      const readmeAction = actions.find(a => a.file_path === "README.md")!;
      assert.ok(readmeAction.content.includes("# My Project"), "Title typo fixed");
      assert.ok(readmeAction.content.includes("Installation guide"), "Installation typo fixed");

      assert.strictEqual(receivedCommitBody?.branch, "main");
      assert.strictEqual(receivedCommitBody?.commit_message, "Fix config and typos");
      assert.strictEqual((result as { id: string }).id, MOCK_COMMIT.id);
    } finally {
      await mockServer.stop();
    }
  });

  test("should apply multiple changes to a single file sequentially", async () => {
    const mockPort = await findMockServerPort();
    const mockServer = new MockGitLabServer({ port: mockPort, validTokens: [MOCK_TOKEN] });
    let receivedCommitBody: Record<string, unknown> | undefined;

    mockServer.addMockHandler(
      "get",
      `/projects/${PROJECT_ID}/repository/files/src%2Fapp.ts`,
      (_req, res) => {
        res.status(200).json(
          makeFileResponse("src/app.ts", "const host = 'localhost';\nconst debug = true;\n")
        );
      }
    );
    mockServer.addMockHandler("post", `/projects/${PROJECT_ID}/repository/commits`, (req, res) => {
      receivedCommitBody = req.body as Record<string, unknown>;
      res.status(201).json(MOCK_COMMIT);
    });

    await mockServer.start();

    try {
      await callEditFiles(
        {
          project_id: PROJECT_ID,
          branch: "main",
          commit_message: "Update app config",
          files: [
            {
              file_path: "src/app.ts",
              changes: [
                { search: "const host = 'localhost';", replace: "const host = '0.0.0.0';" },
                { search: "const debug = true;", replace: "const debug = false;" },
              ],
            },
          ],
        },
        {
          GITLAB_API_URL: `${mockServer.getUrl()}/api/v4`,
          GITLAB_PERSONAL_ACCESS_TOKEN: MOCK_TOKEN,
        }
      );

      const actions = receivedCommitBody?.actions as Array<{
        action: string;
        file_path: string;
        content: string;
      }>;

      assert.strictEqual(actions.length, 1);
      assert.strictEqual(actions[0].action, "update");
      assert.ok(actions[0].content.includes("const host = '0.0.0.0';"), "host updated");
      assert.ok(actions[0].content.includes("const debug = false;"), "debug updated");
    } finally {
      await mockServer.stop();
    }
  });

  test("should throw an error when search string is not found in file", async () => {
    const mockPort = await findMockServerPort();
    const mockServer = new MockGitLabServer({ port: mockPort, validTokens: [MOCK_TOKEN] });

    mockServer.addMockHandler(
      "get",
      `/projects/${PROJECT_ID}/repository/files/src%2Ffoo.ts`,
      (_req, res) => {
        res.status(200).json(makeFileResponse("src/foo.ts", "const x = 1;\n"));
      }
    );

    await mockServer.start();

    try {
      await assert.rejects(
        () =>
          callEditFiles(
            {
              project_id: PROJECT_ID,
              branch: "main",
              commit_message: "Should fail",
              files: [
                {
                  file_path: "src/foo.ts",
                  changes: [{ search: "does not exist", replace: "something" }],
                },
              ],
            },
            {
              GITLAB_API_URL: `${mockServer.getUrl()}/api/v4`,
              GITLAB_PERSONAL_ACCESS_TOKEN: MOCK_TOKEN,
            }
          ),
        /Search string not found/
      );
    } finally {
      await mockServer.stop();
    }
  });
});
