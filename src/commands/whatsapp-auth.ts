import type { TraulConfig } from "../lib/config";

function getHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-Api-Key"] = apiKey;
  return headers;
}

export async function runWhatsAppAuth(config: TraulConfig, accountName: string): Promise<void> {
  const instance = config.whatsapp.instances.find((i) => i.name === accountName);
  if (!instance) {
    console.error(`WhatsApp instance "${accountName}" not found in config.`);
    console.error("Add it to whatsapp.instances in ~/.config/traul/config.json:");
    console.error(JSON.stringify({
      whatsapp: {
        instances: [{ name: accountName, url: "http://localhost:3000", api_key: "", session: "default", chats: [] }],
      },
    }, null, 2));
    process.exit(1);
  }

  const { url, api_key, session } = instance;
  const headers = getHeaders(api_key);

  console.log(`Starting WAHA session "${session}" on ${url}...`);
  try {
    const startResp = await fetch(`${url}/api/sessions/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: session }),
    });

    if (!startResp.ok && startResp.status !== 409 && startResp.status !== 422) {
      const body = await startResp.text();
      console.error(`Failed to start session: ${startResp.status} ${body}`);
      process.exit(1);
    }
  } catch {
    console.error(`Cannot reach WAHA at ${url}. Is it running?`);
    console.error("Start it with: docker compose -f docker-compose.waha.yml up -d");
    process.exit(1);
  }

  const statusResp = await fetch(`${url}/api/sessions/${session}`, { headers });
  const status = await statusResp.json() as { status: string };

  if (status.status === "WORKING") {
    console.log("Session already authenticated!");
    return;
  }

  console.log("\nScan this QR code with WhatsApp on your phone:\n");

  const qrResp = await fetch(`${url}/api/${session}/auth/qr?format=raw`, { headers });
  if (!qrResp.ok) {
    console.error(`Failed to get QR code: ${qrResp.status}`);
    process.exit(1);
  }

  const qrData = await qrResp.json() as { value: string };

  try {
    const proc = Bun.spawn(["npx", "--yes", "qrcode-terminal"], {
      stdin: new Blob([qrData.value + "\n"]),
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  } catch {
    console.log("QR value (scan with a QR reader or open in browser):");
    console.log(`${url}/api/${session}/auth/qr?format=image`);
  }

  console.log("\nWaiting for authentication...");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const checkResp = await fetch(`${url}/api/sessions/${session}`, { headers });
    const checkStatus = await checkResp.json() as { status: string };

    if (checkStatus.status === "WORKING") {
      console.log("WhatsApp authenticated successfully!");
      return;
    }
  }

  console.error("Authentication timed out (120s). Try again.");
  process.exit(1);
}
