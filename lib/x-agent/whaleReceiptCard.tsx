import React, { type CSSProperties, type ReactNode } from "react";
import type { WhaleReceiptData } from "@/lib/x-agent/whaleReceiptTypes";

const palette = {
  bg: "#070b14",
  card: "#0f172a",
  border: "#1e293b",
  accent: "#34d399",
  accentMuted: "#10b981",
  text: "#f8fafc",
  muted: "#94a3b8",
  label: "#64748b",
  badge: "#14532d",
  badgeText: "#bbf7d0",
  statBg: "#111827",
} as const;

function StatCell({
  label,
  value,
  valueColor = palette.text,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        backgroundColor: palette.statBg,
        borderRadius: 16,
        padding: "20px 24px",
        border: `1px solid ${palette.border}`,
        flex: 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 20,
          fontWeight: 600,
          color: palette.label,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 40,
          fontWeight: 700,
          color: valueColor,
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ReceiptRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        gap: 16,
        width: "100%",
      }}
    >
      {children}
    </div>
  );
}

export function WhaleReceiptCard({ data }: { data: WhaleReceiptData }) {
  const rootStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    backgroundColor: palette.bg,
    color: palette.text,
    padding: 48,
    fontFamily: "Inter",
  };

  const evColor =
    data.avgEvPercent.startsWith("-") || data.avgEvPercent === "0%"
      ? palette.muted
      : palette.accent;

  return (
    <div style={rootStyle}>
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 28,
        }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "0.2em",
            color: palette.accent,
            textTransform: "uppercase",
          }}
        >
          Whale Trade Receipt
        </div>
        <div
          style={{
            fontSize: 20,
            fontWeight: 600,
            color: palette.muted,
          }}
        >
          Prediction Whales
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          backgroundColor: palette.card,
          border: `2px solid ${palette.border}`,
          borderRadius: 24,
          padding: 40,
        }}
      >
        <div
          style={{
            fontSize: 24,
            fontWeight: 600,
            color: palette.label,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 12,
          }}
        >
          Market
        </div>
        <div
          style={{
            fontSize: 44,
            fontWeight: 800,
            lineHeight: 1.15,
            marginBottom: 28,
            maxHeight: 110,
            overflow: "hidden",
          }}
        >
          {data.marketTitle}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            marginBottom: 32,
          }}
        >
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              color: palette.muted,
            }}
          >
            Backing
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 800,
              color: palette.accent,
              backgroundColor: palette.badge,
              borderRadius: 999,
              padding: "10px 22px",
            }}
          >
            {data.outcomeSide}
          </div>
        </div>

        <ReceiptRow>
          <StatCell label="Stake" value={data.stakeLabel} />
          <StatCell label="Entry" value={data.entryLabel} />
          <StatCell label="Now" value={data.nowLabel} />
        </ReceiptRow>

        <div style={{ height: 16 }} />

        <ReceiptRow>
          <StatCell label="Win Rate" value={data.winRateLabel} />
          <StatCell label="Avg EV" value={data.avgEvLabel} valueColor={evColor} />
        </ReceiptRow>

        <div style={{ flex: 1 }} />

        <div
          style={{
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 28,
            paddingTop: 24,
            borderTop: `1px solid ${palette.border}`,
          }}
        >
          <div
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: palette.label,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Whale
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 800,
              color: palette.badgeText,
              backgroundColor: palette.badge,
              border: `1px solid ${palette.accentMuted}`,
              borderRadius: 999,
              padding: "12px 28px",
              maxWidth: 720,
              overflow: "hidden",
            }}
          >
            {data.whaleBadge}
          </div>
        </div>
      </div>
    </div>
  );
}
