const token = process.env.TEST_ACCESS_TOKEN;
if (!token) {
  console.error("Set TEST_ACCESS_TOKEN env var before running this script.");
  process.exit(1);
}

const workspaceId = "74e640c5-7d5e-4d1e-9620-7279a2be5fe8";
const projectId = "7dcc6f18-4953-460c-8d89-9e42f0f828ca";

async function testApi() {
  const endpoints = [
    `http://127.0.0.1:4040/api/workspace/${workspaceId}/projects/${projectId}/documents`,
    `http://127.0.0.1:4040/api/workspace/${workspaceId}/projects/${projectId}/slides`,
    `http://127.0.0.1:4040/api/workspace/${workspaceId}/projects/${projectId}/notes`,
    `http://127.0.0.1:4040/api/workspace/${workspaceId}/projects/${projectId}/tasks`,
    `http://127.0.0.1:4040/api/workspace/${workspaceId}/projects/${projectId}/diagrams`,
  ];

  console.log("Testing API endpoints with token...\n");

  for (const url of endpoints) {
    const module = url.split("/").pop();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      });
      const data = await res.json();
      console.log(`✓ ${module}: ${res.status} - ${JSON.stringify(data).substring(0, 100)}`);
    } catch (e) {
      console.log(`✗ ${module}: ERROR - ${e.message}`);
    }
  }
}

testApi();