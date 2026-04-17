"""
CDP console capture - waits for build_table/Room._ready output.
Does NOT navigate (tab should already be on the game page).
"""
import asyncio, json, websockets, urllib.request, time, sys

CDP_HOST = "http://localhost:9222"
CAPTURE_SECONDS = 300  # 5 minutes

async def main():
    with urllib.request.urlopen(f"{CDP_HOST}/json") as r:
        tabs = json.loads(r.read())

    # Pick the ttclub2 tab, or first tab
    tab = None
    for t in tabs:
        if "ttclub2" in t.get("url", "") or "seepcards" in t.get("url", ""):
            tab = t
            break
    if not tab:
        tab = tabs[0]

    ws_url = tab["webSocketDebuggerUrl"]
    print(f"Tab: {tab.get('url','?')}")
    print(f"Capturing for {CAPTURE_SECONDS}s — host a game now if not already in one\n")

    messages = []
    global _id
    _id = 0

    async with websockets.connect(ws_url, max_size=None) as ws:
        async def send(method, params=None):
            global _id
            _id += 1
            await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))

        await send("Runtime.enable")
        await send("Console.enable")
        await send("Log.enable")

        deadline = time.time() + CAPTURE_SECONDS
        build_table_seen = False

        try:
            while time.time() < deadline:
                remaining = deadline - time.time()
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=min(5.0, remaining))
                except asyncio.TimeoutError:
                    elapsed = int(CAPTURE_SECONDS - remaining)
                    print(f"  [{elapsed}s elapsed, waiting...]", end="\r", flush=True)
                    continue

                msg = json.loads(raw)
                method = msg.get("method", "")

                text = None
                level = "log"

                if method == "Runtime.consoleAPICalled":
                    p = msg["params"]
                    level = p.get("type", "log")
                    args = p.get("args", [])
                    text = " ".join(
                        a.get("value", a.get("description", str(a))) for a in args
                    )
                elif method == "Log.entryAdded":
                    entry = msg["params"].get("entry", {})
                    level = entry.get("level", "?")
                    text = entry.get("text", "")
                elif method == "Runtime.exceptionThrown":
                    exc = msg["params"].get("exceptionDetails", {})
                    level = "EXCEPTION"
                    text = f"{exc.get('text','')} {exc.get('exception',{}).get('description','')}"

                if text is not None:
                    # Filter out spammy WebGL warnings unless they're unique
                    if "GL_INVALID_OPERATION" in text:
                        continue
                    if "Feedback loop" in text:
                        continue

                    ts = time.strftime("%H:%M:%S")
                    line = f"[{ts}] [{level}] {text}"
                    print(line)
                    sys.stdout.flush()
                    messages.append(line)

                    if "build_table" in text or "Room._ready" in text:
                        build_table_seen = True

                    # Stop early once we've seen the key debug output
                    if build_table_seen and "table children after extract" in text:
                        print("\n[DONE] Captured build_table complete output")
                        break

        except KeyboardInterrupt:
            print("\nInterrupted")

    print(f"\n=== {len(messages)} entries captured ===")
    with open("/tmp/console2.txt", "w") as f:
        f.write("\n".join(messages))
    print("Saved to /tmp/console2.txt")

asyncio.run(main())
