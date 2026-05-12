/**
 * Minimal SSE client for fetch-based POST streams (EventSource only supports GET).
 *
 * Consumes an HTTP response whose body is text/event-stream and calls `onEvent`
 * for each `event: <name>\ndata: <json>\n\n` block. `onClose` fires when the
 * stream ends (naturally or via `abort`).
 */
export interface SseEvent {
  event: string;
  data: string;
}

export interface SseOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  onEvent: (event: SseEvent) => void;
  onError?: (error: unknown) => void;
  onClose?: () => void;
}

export async function openSse(url: string, opts: SseOptions): Promise<void> {
  const { method = "POST", body, signal, onEvent, onError, onClose } = opts;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal
    });
  } catch (err) {
    onError?.(err);
    onClose?.();
    return;
  }

  if (!response.ok || !response.body) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const text = await response.text();
      if (text) message += ` — ${text}`;
    } catch {
      /* ignore */
    }
    onError?.(new Error(message));
    onClose?.();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on event-stream record delimiter (blank line)
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const parsed = parseSseBlock(raw);
        if (parsed) onEvent(parsed);

        boundary = buffer.indexOf("\n\n");
      }
    }
    // Flush trailing block if any
    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed) onEvent(parsed);
    }
  } catch (err) {
    if ((err as { name?: string })?.name !== "AbortError") {
      onError?.(err);
    }
  } finally {
    onClose?.();
  }
}

function parseSseBlock(raw: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line.startsWith(":")) continue; // comment line
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}
