const LESSONS = [
  {
    icon: "🌍",
    title: "What is a prediction market?",
    text: "A prediction market is like a poll where people bet real money on what they think will happen. The price IS the probability — if a market shows 60%, that means the crowd thinks there's a 60% chance of it happening.",
    example:
      "France at 16% means out of 100 people, only 16 think France will win.",
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
