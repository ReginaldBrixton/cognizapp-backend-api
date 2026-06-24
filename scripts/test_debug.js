const token = process.env.TEST_ACCESS_TOKEN;
if (!token) {
  console.error("Set TEST_ACCESS_TOKEN env var before running this script.");
  process.exit(1);
}

const workspaceId = "74e640c5-7d5e-4d1e-9620-7279a2be5fe8";
const projectId = "7dcc6f18-4953-460c-8d89-9e42f0f828ca";

async function testApi() {
  const url = `http://127.0.0.1:4040/api/workspace/${workspaceId}/projects/${projectId}/documents`;
  
  console.log("Testing documents endpoint...\n");
  console.log("URL:", url);
  console.log("Token:", token.substring(0, 50) + "...");
  
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    
    console.log("Status:", res.status);
    console.log("Status Text:", res.statusText);
    console.log("Headers:", Object.fromEntries(res.headers.entries()));
    
    const text = await res.text();
    console.log("\nResponse body:");
    console.log(text);
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

testApi();