import type { JSX } from "react";

type MessageListProps = {
  items?: string[];
  tone: "error" | "warning";
};

const MessageList = ({items, tone}: MessageListProps): JSX.Element | null => {
  if (!items || items.length === 0) {
    return null;
  }
  const className = tone === "error" ? "status err" : "status warn";
  const heading = tone === "error" ? "Errors" : "Warnings";
  return (
    <section className="card">
      <h2>{heading}</h2>
      <ul>
        {items.map((item, idx) => (
          <li key={`${tone}-${idx}`}>
            <span className={className}>{heading.slice(0, -1)}</span>
            &nbsp;{item}
          </li>
        ))}
      </ul>
    </section>
  );
};

export default MessageList;
