import { MONO } from "../fonts";
import type { Theme } from "../theme";
import { tint, useTheme } from "../theme";

// Just enough TypeScript highlighting for the snippets shown here: strings
// and template literals, the regex literal, keywords, calls, object keys.
const TOKEN =
  /(`[^`]*`|"[^"]*")|(\/\^npm \/)|\b(const|if|return)\b|([A-Za-z_$][\w$]*)(?=\()|([A-Za-z_$][\w$]*)(?=:)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g;

const colorize = (line: string, theme: Theme) =>
  [...line.matchAll(TOKEN)].map((match, i) => {
    const [text, string, regex, keyword, call, property] = match;
    const color =
      string !== undefined || regex !== undefined
        ? theme.syntax.string
        : keyword !== undefined
          ? theme.syntax.keyword
          : call !== undefined
            ? theme.syntax.call
            : property !== undefined
              ? theme.syntax.property
              : theme.syntax.punctuation;
    return (
      <span key={i} style={{ color }}>
        {text}
      </span>
    );
  });

export const LINE_HEIGHT = 27;

/**
 * Highlighted source lines. `reveal(i)` gives each line's entrance (0-1);
 * lines inside `focus` stay bright with a band behind them while the rest dim
 * by `focusStrength`.
 */
export const Code = ({
  lines,
  reveal,
  focus,
  focusStrength = 0,
  fontSize = 17,
}: {
  lines: readonly string[];
  reveal: (index: number) => number;
  focus?: readonly [number, number];
  focusStrength?: number;
  fontSize?: number;
}) => {
  const theme = useTheme();
  return (
    <div style={{ fontFamily: MONO, fontSize, lineHeight: `${LINE_HEIGHT}px`, whiteSpace: "pre" }}>
      {lines.map((line, i) => {
        const inFocus = focus !== undefined && i >= focus[0] && i <= focus[1];
        const shown = reveal(i);
        return (
          <div
            key={i}
            style={{
              position: "relative",
              opacity: shown * (inFocus ? 1 : 1 - 0.6 * focusStrength),
              transform: `translateX(${(1 - shown) * 14}px)`,
            }}
          >
            {inFocus && (
              <div
                style={{
                  position: "absolute",
                  inset: "0 -24px",
                  background: tint(theme.syntax.call, 0.12 * focusStrength),
                  borderLeft: `3px solid ${tint(theme.syntax.call, focusStrength)}`,
                }}
              />
            )}
            <span style={{ position: "relative" }}>{line === "" ? " " : colorize(line, theme)}</span>
          </div>
        );
      })}
    </div>
  );
};
