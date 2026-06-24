# CognizAP Usage Guide

## Getting Started

### Prerequisites
- Bun runtime installed
- PostgreSQL database
- Firebase project credentials

### Environment Setup

Create `.env` file:
```env
# Runtime
ENVIRONMENT=development
PORT=4040
LOCAL_TEST_ENDPOINT_PATH=/__local/cognizap-users/prismatic-orbit-lighthouse-7f3c9d11/smoke-test

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/cognizap

# Firebase
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CREDENTIALS_BASE64=<base64-service-account-json>

# JWT
JWT_SECRET=replace-with-a-32-char-minimum-secret
```

### Installation

```bash
# Install dependencies
bun install

# Start development server with auto reload + auto linting
bun run dev
```

Local dev endpoints:
- Root: `http://localhost:4040/`
- Swagger docs: `http://localhost:4040/docs`
- Unique smoke test: `http://localhost:4040/__local/cognizap-users/prismatic-orbit-lighthouse-7f3c9d11/smoke-test`

### Start Another Local Server

PowerShell:
```powershell
$env:PORT=3012
$env:LOCAL_TEST_ENDPOINT_PATH="/__local/cognizap-users/aurora-drift-harbor-3012/smoke-test"
bun run dev
```

Use `bun run dev:server` if you only want the API process without the Biome watcher.

## API Usage Examples

### Authentication

```typescript
// Exchange Firebase token
const response = await fetch("/api/auth/firebase/exchange", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ firebaseToken: "..." }),
});
const { accessToken, refreshToken } = await response.json();

// Store tokens
localStorage.setItem("accessToken", accessToken);
```

### Making Authenticated Requests

```typescript
const response = await fetch("/api/user/workspace", {
  headers: {
    Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
  },
});
```

### Creating a Workspace

```typescript
const response = await fetch("/api/user/workspace", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    name: "My Research Project",
    description: "Research workspace",
    color: "#3b82f6",
  }),
});
```

### Creating a Project

```typescript
const response = await fetch(`/api/workspace/${workspaceId}/projects`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    title: "AI Research Paper",
    fieldOfStudy: "Computer Science",
    projectType: "research",
    keywords: ["AI", "ML", "NLP"],
  }),
});
```

### Running Analysis

```typescript
const response = await fetch(`/api/workspace/${workspaceId}/analysis/humanise`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    title: "Humanise AI Content",
    originalText: "The quick brown fox...",
  }),
});
```

## Frontend Integration

### React/Vue/Angular Pattern

```typescript
class CognizAPI {
  private baseUrl: string;
  private token: string | null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.token = localStorage.getItem("accessToken");
  }

  async request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: this.token ? `Bearer ${this.token}` : "",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  }

  listWorkspaces() {
    return this.request("GET", "/api/user/workspace");
  }

  createWorkspace(data: unknown) {
    return this.request("POST", "/api/user/workspace", data);
  }

  listProjects(workspaceId: string) {
    return this.request("GET", `/api/workspace/${workspaceId}/projects`);
  }

  createProject(workspaceId: string, data: unknown) {
    return this.request("POST", `/api/workspace/${workspaceId}/projects`, data);
  }
}

const api = new CognizAPI("https://api.cognizapp.com");
```

## Development Mode

### Testing with Playwright

```typescript
test("create workspace", async ({ page }) => {
  await page.goto("/");
  await page.fill('[name="email"]', "test@example.com");
  await page.fill('[name="password"]', "password");
  await page.click('button[type="submit"]');

  await page.click('button:has-text("New Workspace")');
  await page.fill('[name="name"]', "Test Workspace");
  await page.click('button:has-text("Create")');

  await expect(page.locator("text=Test Workspace")).toBeVisible();
});
```

## Common Operations

### Refresh Token
```typescript
const response = await fetch("/api/auth/refresh", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ refreshToken }),
});
const { accessToken } = await response.json();
```

### List User Sessions
```typescript
const response = await fetch("/api/auth/sessions", {
  headers: { Authorization: `Bearer ${token}` },
});
const { sessions } = await response.json();
```

### Revoke Session
```typescript
await fetch(`/api/auth/sessions/${sessionId}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${token}` },
});
```

## Error Handling

```typescript
async function apiRequest(url: string, options: RequestInit) {
  try {
    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }

    return data;
  } catch (error) {
    if (error instanceof Error && error.message === "Token expired") {
      await refreshToken();
      return apiRequest(url, options);
    }
    throw error;
  }
}
```
