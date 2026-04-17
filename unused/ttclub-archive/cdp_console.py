"""
CDP console capture script.
Navigates to ttclub2, captures all console output for 120 seconds.
Run: python cdp_console.py
"""
import asyncio, json, websockets, urllib.request, time, sys

CDP_HOST = "http://localhost:9222"
GAME_URL = "http://localhost:2567/ttclub2/seepcards.html"
CAPTURE_SECONDS = 120

async def main():
    # Get tab list
    with urllib.request.urlopen(f"{CDP_HOST}/json") as r:
        tabs = json.loads(r.read())

    tab = tabs[0]
    ws_url = tab["webSocketDebuggerUrl"]
    print(f"Connecting to tab: {tab.get('url','?')}")
    print(f"Navigating to: {GAME_URL}")

    messages = []

    async with websockets.connect(ws_url, max_size=None) as ws:
        async def send(method, params=None):
            global _id
            _id += 1
            await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))

        global _id
        _id = 0

        # Enable Runtime and Console
        await send("Runtime.enable")
        await send("Console.enable")
        await send("Log.enable")

        # Navigate to new URL
        await send("Page.navigate", {"url": GAME_URL})

        print(f"\nCapturing console for {CAPTURE_SECONDS}s — host a game in the browser now...\n")
        deadline = time.time() + CAPTURE_SECONDS

        try:
            while time.time() < deadline:
                remaining = deadline - time.time()
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=min(5.0, remaining))
                except asyncio.TimeoutError:
                    print(f"  [{int(CAPTURE_SECONDS - (deadline - time.time()))}s elapsed]", end="\r", flush=True)
                    continue

                msg = json.loads(raw)
                method = msg.get("method", "")

                if method == "Runtime.consoleAPICalled":
                    p = msg["params"]
                    level = p.get("type", "log")
                    args = p.get("args", [])
                    text = " ".join(
                        a.get("value", a.get("description", str(a))) for a in args
                    )
                    ts = time.strftime("%H:%M:%S")
                    line = f"[{ts}] [{level}] {text}"
                    print(line)
                    messages.append(line)
                elif method == "Log.entryAdded":
                    entry = msg["params"].get("entry", {})
                    ts = time.strftime("%H:%M:%S")
                    line = f"[{ts}] [Log/{entry.get('level','?')}] {entry.get('text','')}"
                    print(line)
                    messages.append(line)
                elif method == "Runtime.exceptionThrown":
                    exc = msg["params"].get("exceptionDetails", {})
                    ts = time.strftime("%H:%M:%S")
                    line = f"[{ts}] [EXCEPTION] {exc.get('text','')} {exc.get('exception',{}).get('description','')}"
                    print(line)
                    messages.append(line)

        except KeyboardInterrupt:
            print("\nInterrupted by user")

    print(f"\n=== Captured {len(messages)} console entries ===")
    # Write to file for later review
    with open("/tmp/console_output.txt", "w") as f:
        f.write("\n".join(messages))
    print("Written to /tmp/console_output.txt")

asyncio.run(main())
