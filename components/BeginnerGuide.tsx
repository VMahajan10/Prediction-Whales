import { formatImpliedProbabilitySummary } from "@/lib/tradeDetail";

const LESSONS = [
  {
    icon: "🌍",
    title: "What is a prediction market?",
    text: "Traders bet real money on outcomes. The price IS implied probability — if a market shows 60%, money is pricing a ~60% chance. That reflects how much capital is at risk, not a headcount of opinions.",
    example: `France at 16¢ → ${formatImpliedProbabilitySummary(0.16)}. A $10 bet and a $10,000 bet both trade at that price — size doesn't change the quote, but large orders move it.`,
  },
  {
    icon: "💰",
    title: "How do you make money?",
    text: "You make money when the probability moves in your direction OR when the event resolves in your favor. Buy low, sell high — just like stocks.",
    example:
      "Buy YES at 20% → probability moves to 35%\nYour $100 is now worth $175 → +$75 profit\nYou didn't even need to wait for the result!",
  },
  {
    icon: "⚠️",
    title: "What is risk?",
    text: "Every bet has two outcomes. If you're wrong, you lose what you put in. Never bet more than you can afford to lose. Start small and learn the patterns.",
    example:
      "Bet $10 on a 20% market:\n✅ Win: get back $50 (+$40)\n❌ Lose: lose your $10\nExpected value: (20% × $50) - $10 = $0\nThis is a fair bet.",
  },
];

export default function BeginnerGuide() {
  return (
    <div className="mb-6 flex flex-col gap-4 lg:flex-row">
      {LESSONS.map((lesson) => (
        <div
          key={lesson.title}
          className="flex-1 rounded-xl border border-slate-700 bg-slate-800 p-5"
        >
          <div className="mb-2 text-2xl">{lesson.icon}</div>
          <h3 className="mb-2 font-semibold text-white">{lesson.title}</h3>
          <p className="mb-3 text-sm leading-relaxed text-slate-400">
            {lesson.text}
          </p>
          <div className="whitespace-pre-line rounded-lg bg-slate-900 p-3 text-xs text-slate-300">
            {lesson.example}
          </div>
        </div>
      ))}
    </div>
  );
}
