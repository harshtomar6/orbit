import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { commandQuery, rankCommands, type CommandCategory } from "../lib/command-palette";

const RECENT_COMMANDS_KEY = "orbit:recent-commands";

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  category: CommandCategory;
  group: string;
  icon: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

function readRecentCommands(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(RECENT_COMMANDS_KEY) ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : []; }
  catch { return []; }
}

export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: CommandItem[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState(readRecentCommands);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const results = useMemo(() => rankCommands(commands, query, recentIds).slice(0, 60), [commands, query, recentIds]);
  const parsed = commandQuery(query);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery(""); setActiveIndex(0);
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => { cancelAnimationFrame(frame); previousFocus.current?.focus(); };
  }, [open]);

  useEffect(() => { setActiveIndex((current) => Math.min(current, Math.max(0, results.length - 1))); }, [results.length]);
  useEffect(() => { document.querySelector<HTMLElement>(`[data-command-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" }); }, [activeIndex]);

  function execute(command: CommandItem | undefined) {
    if (!command || command.disabled) return;
    const next = [command.id, ...recentIds.filter((id) => id !== command.id)].slice(0, 8);
    setRecentIds(next);
    try { localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next)); } catch { /* recents are optional */ }
    onClose();
    requestAnimationFrame(() => void command.run());
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => Math.min(results.length - 1, current + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => Math.max(0, current - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); execute(results[activeIndex]); }
    else if (event.key === "Escape") { event.preventDefault(); onClose(); }
  }

  if (!open) return null;
  return <div className="command-palette-backdrop" onMouseDown={onClose} role="presentation">
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command menu" onMouseDown={(event) => event.stopPropagation()}>
      <div className="command-search"><span>⌕</span>{parsed.prefix && <kbd>{parsed.prefix}</kbd>}<input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} onKeyDown={handleKeyDown} placeholder="Search Orbit or type a prefix…" aria-label="Search commands" aria-controls="orbit-command-results" aria-activedescendant={results[activeIndex] ? `orbit-command-${results[activeIndex]!.id}` : undefined} /><kbd>esc</kbd></div>
      <div className="command-results" id="orbit-command-results" role="listbox">
        {results.length ? results.map((command, index) => <button id={`orbit-command-${command.id}`} data-command-index={index} className={index === activeIndex ? "active" : ""} disabled={command.disabled} role="option" aria-selected={index === activeIndex} key={command.id} onMouseEnter={() => setActiveIndex(index)} onClick={() => execute(command)}><span className={`command-icon ${command.category}`}>{command.icon}</span><span className="command-copy"><strong>{command.label}</strong>{command.description && <small>{command.description}</small>}</span><span className="command-group">{command.group}</span>{command.shortcut && <kbd>{command.shortcut}</kbd>}<i>↵</i></button>) : <div className="command-empty"><span>⌕</span><strong>No matching commands</strong><p>Try a name, action, or one of the prefixes below.</p></div>}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span className="command-prefixes"><b>&gt;</b> Actions <b>@</b> Connections <b>/</b> Data <b>#</b> Views</span></footer>
    </section>
  </div>;
}
