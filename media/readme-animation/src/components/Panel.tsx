import type { CSSProperties, ReactNode } from "react";

import { MONO } from "../fonts";
import { useTheme } from "../theme";

/** A window-like card: optional title bar, then content. */
export const Panel = ({
  title,
  children,
  style,
  borderColor,
}: {
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
  borderColor?: string;
}) => {
  const theme = useTheme();
  return (
    <div
      style={{
        position: "absolute",
        background: theme.panel,
        border: `1.5px solid ${borderColor ?? theme.border}`,
        borderRadius: 14,
        overflow: "hidden",
        ...style,
      }}
    >
      {title !== undefined && (
        <div
          style={{
            height: 40,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 16px",
            borderBottom: `1.5px solid ${theme.border}`,
            fontFamily: MONO,
            fontSize: 15,
            color: theme.muted,
          }}
        >
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: theme.border }} />
          ))}
          <span style={{ marginLeft: 8 }}>{title}</span>
        </div>
      )}
      {children}
    </div>
  );
};

// Drawn rather than typed: check marks and arrows sit outside the web fonts'
// latin subset, and a system fallback would differ between machines.
export const CheckIcon = ({ color, size = 18 }: { color: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
    <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
  </svg>
);

export const CrossIcon = ({ color, size = 18 }: { color: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
  </svg>
);

export const ArrowIcon = ({ color, size = 18 }: { color: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
    <path
      d="M2 8h11M9 4l4 4-4 4"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
