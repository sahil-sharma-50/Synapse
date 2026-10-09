import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Message {
  id: number;
  conversation: string;
  role: string;
  content: string;
  model: string;
  created_at: number;
  status: string;
}

export default function AiHistory() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let disposed = false;
    let running = false;
    let refreshAgain = false;
    let first = true;
    async function refresh() {
      refreshAgain = true;
      if (running) return;
      running = true;
      try {
        while (refreshAgain && !disposed) {
          refreshAgain = false;
          const page = await invoke<Message[]>("get_ai_history", { before: null });
          if (disposed) break;
          setMessages((current) =>
            [...page, ...current.filter((old) => !page.some((item) => item.id === old.id))].sort(
              (a, b) => b.id - a.id,
            ),
          );
          if (first) {
            setMore(page.length === 100);
            first = false;
          }
          setError("");
        }
      } catch (cause) {
        if (!disposed) setError(String(cause));
      } finally {
        running = false;
        if (!disposed) setLoading(false);
      }
    }
    const changed = listen("ai-history-changed", () => void refresh());
    const failed = listen<string>("ai-history-error", ({ payload }) => setError(payload));
    void changed.then(refresh).catch((cause) => {
      if (!disposed) {
        setError(String(cause));
        setLoading(false);
      }
    });
    return () => {
      disposed = true;
      void changed.then((unlisten) => unlisten());
      void failed.then((unlisten) => unlisten());
    };
  }, []);

  async function loadOlder() {
    setLoading(true);
    try {
      const page = await invoke<Message[]>("get_ai_history", {
        before: messages[messages.length - 1]?.id,
      });
      setMessages((current) => [
        ...current,
        ...page.filter((item) => !current.some((old) => old.id === item.id)),
      ]);
      setMore(page.length === 100);
      setError("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }

  const conversations = new Map<string, Message[]>();
  for (const message of messages) {
    const group = conversations.get(message.conversation) ?? [];
    group.unshift(message);
    conversations.set(message.conversation, group);
  }

  return (
    <section className="set-section set-ai-history" aria-labelledby="ai-history-heading">
      <div className="set-page-head">
        <h2 className="set-title" id="ai-history-heading">
          Conversation history
        </h2>
        <p className="set-subtitle">
          Saved on this device. Includes greetings, your words, and AI replies. Interrupted replies
          may include text that had not yet been spoken.
        </p>
      </div>
      {error && (
        <p className="set-error" role="alert">
          Could not load or save history: {error}
        </p>
      )}
      {!messages.length && (
        <p className="set-card-row set-sublabel">
          {loading ? "Loading conversations…" : "No conversations yet. Open AI and say hello."}
        </p>
      )}
      {[...conversations].map(([id, entries], index) => (
        <details className="set-card set-ai-conversation" key={id} open={index === 0}>
          <summary>
            <time dateTime={new Date(entries[0].created_at).toISOString()}>
              {new Date(entries[0].created_at).toLocaleString()}
            </time>
            <span>{entries.find((entry) => entry.role === "user")?.content || "Greeting"}</span>
          </summary>
          <ol className="set-ai-messages">
            {entries.map((entry) => (
              <li key={entry.id}>
                <div className="set-ai-message-meta">
                  <strong>
                    {entry.role === "user"
                      ? "You"
                      : entry.role === "action"
                        ? "Computer action"
                        : "Synapse"}
                  </strong>
                  <time>
                    {new Date(entry.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  {entry.status !== "complete" && (
                    <span>
                      {entry.status === "pending"
                        ? "In progress"
                        : entry.status === "interrupted"
                          ? "Interrupted"
                          : "Failed"}
                    </span>
                  )}
                </div>
                <p>
                  {entry.content ||
                    (entry.status === "pending" ? "Preparing a reply…" : "Stopped before a reply.")}
                </p>
                {entry.role === "assistant" && <small>{entry.model}</small>}
              </li>
            ))}
          </ol>
        </details>
      ))}
      {more && (
        <button
          className="set-btn set-btn-quiet"
          disabled={loading}
          onClick={() => void loadOlder()}
        >
          {loading ? "Loading…" : "Load older messages"}
        </button>
      )}
    </section>
  );
}
