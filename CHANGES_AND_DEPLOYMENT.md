# GitLab MCP — Custom Build & Deployment Guide

> This is a custom build based on the upstream repository [zereight/gitlab-mcp](https://github.com/zereight/gitlab-mcp).

## Changes from upstream (v2.1.26 → custom)

### 1. Added `delete_files` tool

Deletes multiple files in a single GitLab commit using the Commits API with `action: "delete"`.

**Files changed:**
- `schemas.ts` — added `DeleteFilesSchema` with `project_id`, `branch`, `files[]`, `commit_message`
- `tools/registry.ts` — registered `delete_files` in `allTools`, `destructiveTools`, and the `repositories` toolset
- `index.ts` — added dispatch case for `delete_files`
- `test/test-delete-files.ts` — mock-server tests for single and multiple file deletion

**Tool input:**
```json
{
  "project_id": "my-group/my-repo",
  "branch": "main",
  "files": ["src/old-file.ts", "docs/outdated.md"],
  "commit_message": "Remove old files"
}
```

### 2. Commented out STREAMABLE_HTTP + PAT validation

The upstream v2.1.26 added a validation that rejects `STREAMABLE_HTTP=true` combined with `GITLAB_PERSONAL_ACCESS_TOKEN` unless `REMOTE_AUTHORIZATION=true` is also set. AWS AgentCore uses a JWT authorizer on the `Authorization` header, which conflicts with `REMOTE_AUTHORIZATION` mode. The validation is commented out in `index.ts` to allow PAT-based auth with Streamable HTTP.

```typescript
// if (streamableHttp && (hasToken || hasJobToken) && !remoteAuth && !mcpOAuth) {
//   errors.push("STREAMABLE_HTTP=true ... requires REMOTE_AUTHORIZATION=true ...");
// }
```

---

## Build and push to ECR

```bash
# Variables
AWS_ACCOUNT_ID=542115676974
AWS_REGION=us-east-1
ECR_REPO_NAME=gitlab-mcp
IMAGE_TAG=latest

# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION --profile Intelligent-Ops \
  | docker login --username AWS --password-stdin \
    $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Create ECR repo (skip if it already exists)
aws ecr create-repository \
  --repository-name $ECR_REPO_NAME \
  --region $AWS_REGION \
  --profile Intelligent-Ops

# Build the image
docker build -t $ECR_REPO_NAME:$IMAGE_TAG .

# Tag and push
docker tag $ECR_REPO_NAME:$IMAGE_TAG \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:$IMAGE_TAG

docker push \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO_NAME:$IMAGE_TAG
```

---

## Deploy to AWS AgentCore

`STREAMABLE_HTTP=true` is required — AgentCore communicates over HTTP, not stdio.

### Create a new runtime

```bash
aws bedrock-agentcore-control create-agent-runtime \
  --region us-east-1 \
  --profile Intelligent-Ops \
  --agent-runtime-name "gitlab_mcp3" \
  --agent-runtime-artifact '{
    "containerConfiguration": {
      "containerUri": "542115676974.dkr.ecr.us-east-1.amazonaws.com/gitlab-mcp:latest"
    }
  }' \
  --role-arn "arn:aws:iam::542115676974:role/tharun-agentcore-execution-role" \
  --network-configuration '{"networkMode": "PUBLIC"}' \
  --protocol-configuration '{"serverProtocol": "MCP"}' \
  --environment-variables '{
    "GITLAB_PERSONAL_ACCESS_TOKEN": "<your-pat>",
    "GITLAB_ALLOWED_PROJECT_IDS": "6658",
    "STREAMABLE_HTTP": "true",
    "GITLAB_API_URL": "https://gitlab.presidio.com/api/v4",
    "GITLAB_TOOLSETS": "repositories,branches,merge_requests,pipelines",
    "GITLAB_READ_ONLY_MODE": "false",
    "HOST": "0.0.0.0",
    "PORT": "8000"
  }' \
  --authorizer-configuration '{
    "customJWTAuthorizer": {
      "discoveryUrl": "<cognito-discovery-url>",
      "allowedClients": ["<cognito-client-id>"]
    }
  }'
```

---

## Toolset reference

| Toolset | Default | Use case |
|---|---|---|
| `repositories` | yes | File read/write, push, delete |
| `branches` | yes | Branch create/list/protect |
| `merge_requests` | yes | Create/review/merge MRs |
| `issues` | yes | Issue tracking |
| `projects` | yes | Project metadata |
| `labels` | yes | Label management |
| `ci` | yes | Basic CI (trigger pipelines) |
| `users` | yes | User lookup |
| `groups` | yes | Group info |
| `pipelines` | **no** | Pipeline logs, jobs, artifacts |
| `wiki` | **no** | Wiki pages |
| `milestones` | **no** | Milestone management |

For an IaC agent (Terraform), use:
```
GITLAB_TOOLSETS=repositories,branches,merge_requests,pipelines
```

Enable all toolsets with `GITLAB_TOOLSETS=all`.
