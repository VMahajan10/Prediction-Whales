import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const res = await fetch(
      'https://data-api.polymarket.com/trades?limit=200',
      { next: { revalidate: 0 } }
    )
    const data = await res.json()
    
    const trades = (Array.isArray(data) ? data : data.trades ?? []).map((t: any) => ({
      id: t.id,
      title: t.market ?? t.title ?? 'Unknown',
      side: t.side,
      outcome: t.outcome ?? t.outcomeIndex ?? '',
      price: t.price,
      size: parseFloat(t.size ?? t.usdcSize ?? 0),
      timestamp: t.timestamp ?? Math.floor(Date.now() / 1000),
      transactionHash: t.transactionHash ?? t.txHash ?? '',
    }))

    return NextResponse.json({ trades })
  } catch (err) {
    return NextResponse.json({ trades: [], error: String(err) }, { status: 500 })
  }
}
