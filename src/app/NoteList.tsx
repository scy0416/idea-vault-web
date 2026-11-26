import { useState } from "react";
import type { StoredNote } from "../core/note-file.ts";
import { filterNotes, shortTime, tagCounts, type Filter } from "./notes.ts";

const PAGE = 200;
const TOP_TAGS = 20;

export function NoteList(props: {
  notes: StoredNote[];
  /** 아직 올리지 못한 노트의 ID */
  pending: Set<string>;
  /** 본문을 골라야 하는 노트의 ID */
  conflicts?: Set<string> | Map<string, string>;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  onOpen: (id: string) => void;
}) {
  const { notes, pending, filter } = props;
  const [limit, setLimit] = useState(PAGE);

  if (!notes.length) {
    return <p className="empty">아직 노트가 없습니다. 위에 한 줄을 적어 보세요.</p>;
  }

  const counts = tagCounts(notes);
  const top = counts.slice(0, TOP_TAGS);
  // 고른 태그는 적게 쓴 태그여도, 없어진 태그여도 풀 수 있게 보여준다.
  if (filter.tag !== null && !top.some(([t]) => t === filter.tag)) {
    top.push(counts.find(([t]) => t === filter.tag) ?? [filter.tag, 0]);
  }
  const shown = filterNotes(notes, filter);

  return (
    <div className="stack">
      <input
        type="search"
        aria-label="노트 검색"
        placeholder="내용, 태그, 번호 검색"
        value={filter.query}
        onChange={(e) => {
          setLimit(PAGE);
          props.onFilter({ ...filter, query: e.currentTarget.value });
        }}
      />
      {top.length > 0 && (
        <div className="chips" role="group" aria-label="태그로 거르기">
          {top.map(([tag, count]) => (
            <button
              key={tag}
              type="button"
              className="chip"
              aria-pressed={tag === filter.tag}
              onClick={() => {
                setLimit(PAGE);
                props.onFilter({ ...filter, tag: tag === filter.tag ? null : tag });
              }}
            >
              {tag} {count}
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 && <p className="empty">맞는 노트가 없습니다.</p>}
      <ul className="notes">
        {shown.slice(0, limit).map((note) => (
          <li key={note.id}>
            <button type="button" className="note" onClick={() => props.onOpen(note.id)}>
              <span className="note-text">{note.text}</span>
              <span className="meta">
                <span>{shortTime(note.created)}</span>
                {note.tags.map((t) => (
                  <span key={t}>#{t}</span>
                ))}
                {props.conflicts?.has(note.id) ? (
                  <span className="error">내용을 골라야 함</span>
                ) : (
                  pending.has(note.id) && <span className="pending">아직 올리지 못함</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown.length > limit && (
        <button type="button" onClick={() => setLimit(limit + PAGE)}>
          더 보기 ({shown.length - limit}개 남음)
        </button>
      )}
    </div>
  );
}
