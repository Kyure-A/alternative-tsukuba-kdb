import styled from "@emotion/styled";
import { useEffect, useState } from "react";
import Modal from "react-modal";

import { colorPurpleDark } from "@/utils/style";
import { CURRENT_YEAR, kdb } from "@/utils/subject";
import { TWINS_MODULE_LABELS, type TwinsModule } from "@/utils/twins";
import type { useBookmark } from "@/utils/useBookmark";
import { twinsPlanKey, type useTwins } from "@/utils/useTwins";

const Content = styled.div`
  font-size: 14px;
  line-height: 1.7;
  h2 { margin: 0 0 12px; font-size: 19px; color: ${colorPurpleDark}; }
  button { padding: 7px 12px; font: inherit; border: 1px solid #ccc; background: white; border-radius: 5px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  button[data-primary="true"] { background: ${colorPurpleDark}; color: white; border-color: ${colorPurpleDark}; }
  input { accent-color: ${colorPurpleDark}; margin-right: 8px; }
  p { margin: 10px 0; }
  label[data-action] { display: block; padding: 8px 0; border-bottom: 1px solid #eee; }
  small { color: #666; }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
`;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  twins: ReturnType<typeof useTwins>;
  usedBookmark: ReturnType<typeof useBookmark>;
  module: TwinsModule | null;
}

export default function TwinsSync({
  isOpen,
  onClose,
  twins,
  usedBookmark,
  module,
}: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const preview = twins.preview;
  const exceptional = Object.values(twins.snapshots).flatMap((item) =>
    item.entries.filter((entry) => {
      const bookmark = usedBookmark.getBookmarkSubject(entry.code);
      return (
        !kdb.subjectMap[entry.code] ||
        (bookmark && bookmark.year !== CURRENT_YEAR) ||
        entry.intensive ||
        entry.day === null ||
        entry.day > 5 ||
        entry.period === null ||
        entry.period > 6
      );
    }),
  );
  const { desiredByModule: desired } = usedBookmark.getTwinsChanges(
    twins.snapshots,
  );
  const current =
    preview && module && twins.reviewKey === twinsPlanKey(desired);
  useEffect(() => {
    setSelected(preview?.additions.map((action) => action.key) ?? []);
    setConfirmed(false);
  }, [preview]);

  const toggle = (key: string) => {
    setSelected((previous) =>
      previous.includes(key)
        ? previous.filter((item) => item !== key)
        : [...previous, key],
    );
    setConfirmed(false);
  };

  return (
    <Modal
      isOpen={isOpen}
      onRequestClose={onClose}
      appElement={document.getElementById("root") ?? undefined}
      contentLabel="TWINS への反映"
      style={{
        overlay: { zIndex: 100 },
        content: {
          inset: "50% auto auto 50%",
          transform: "translate(-50%, -50%)",
          width: "min(560px, calc(100vw - 48px))",
          maxHeight: "80vh",
          boxSizing: "border-box",
          borderRadius: 10,
          padding: 24,
        },
      }}
    >
      <Content>
        <h2>TWINS へ反映</h2>
        {exceptional.length > 0 && (
          <details>
            <summary>時間割の枠外・科目情報に相違のある登録</summary>
            <ul>
              {exceptional.map((entry, index) => (
                <li key={`${entry.module}-${entry.code}-${index}`}>
                  {TWINS_MODULE_LABELS[entry.module]} · {entry.code} ·{" "}
                  {entry.description || kdb.subjectMap[entry.code]?.name}
                  {!kdb.subjectMap[entry.code]
                    ? "（KdB 未掲載）"
                    : usedBookmark.getBookmarkSubject(entry.code)?.year !==
                        CURRENT_YEAR
                      ? "（履修案の年度設定を保持）"
                      : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
        {twins.busy && <p role="status">{twins.busy}</p>}
        {twins.error && <p role="alert">{twins.error}</p>}
        {preview && !current && (
          <p>履修案が変わりました。差分を取得し直してください。</p>
        )}
        {current && preview && (
          <>
            <p>
              追加 {preview.additions.length} 件・取消 {preview.removals.length}{" "}
              件
            </p>
            {[...preview.additions, ...preview.removals].map((action) => (
              <label data-action key={action.key}>
                <input
                  type="checkbox"
                  checked={selected.includes(action.key)}
                  onChange={() => toggle(action.key)}
                />
                <strong>{action.kind === "add" ? "追加" : "取消"}</strong>　
                {action.code}　{action.name}
                <br />
                <small>
                  {TWINS_MODULE_LABELS[action.module]} · {action.catalogTerm}
                  {action.kind === "add"
                    ? ` / ${["月", "火", "水", "木", "金", "土", "日"][action.day]} ${action.period}限から`
                    : ""}
                </small>
              </label>
            ))}
            {preview.blocked.length > 0 && (
              <details>
                <summary>
                  TWINS での確認が必要な科目（{preview.blocked.length}）
                </summary>
                <ul>
                  {preview.blocked.map((item) => (
                    <li key={item.code}>
                      {item.code}：{item.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {preview.additions.length + preview.removals.length > 0 && (
              <>
                <p>
                  <small>
                    追加・取消は科目単位で、複数モジュールにまたがる授業にも反映されます。
                  </small>
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  TWINS の {CURRENT_YEAR} 年度と、選択した変更内容を確認した
                </label>
              </>
            )}
          </>
        )}
        {twins.result && (
          <>
            <p role="status">
              {twins.result.status === "verified"
                ? "反映を再照会で確認しました。"
                : "一部の結果を確認できませんでした。"}{" "}
              {twins.result.message}
            </p>
            <ul>
              {twins.result.operations.map((operation) => (
                <li key={operation.key}>
                  {operation.code}：
                  {
                    {
                      verified: "確認済み",
                      failed: "失敗",
                      uncertain: "結果不明",
                      skipped: "未実行",
                    }[operation.status]
                  }
                </li>
              ))}
            </ul>
          </>
        )}
        <footer>
          <button type="button" onClick={onClose}>
            閉じる
          </button>
          {twins.error && !twins.busy && (
            <button type="button" onClick={() => twins.reload()}>
              再取得
            </button>
          )}
          {module &&
            !twins.busy &&
            (!current ||
              (preview && Date.parse(preview.expiresAt) <= Date.now())) && (
              <button
                type="button"
                onClick={() => twins.review(module, CURRENT_YEAR, desired)}
              >
                差分を再取得
              </button>
            )}
          {current && preview && (
            <button
              type="button"
              data-primary="true"
              disabled={
                !confirmed ||
                selected.length === 0 ||
                Boolean(twins.busy) ||
                Date.parse(preview.expiresAt) <= Date.now()
              }
              onClick={() => twins.apply(selected, CURRENT_YEAR)}
            >
              選択した {selected.length} 件を反映
            </button>
          )}
        </footer>
      </Content>
    </Modal>
  );
}
