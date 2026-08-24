import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '@/db';
import { policyRules } from '@/db/schema';
import { withRepositoryAccess } from '@/lib/api';
import { DEFAULT_POLICY_RULES } from '@/guardian/policies';

const Body = z.object({
  name: z.string().min(1).max(120),
  trigger: z.enum(['new_finding', 'secret_detected', 'dependency_change', 'test_gap', 'health_drop', 'regression']),
  action: z.enum(['request_changes', 'warn', 'notify', 'run_analysis']),
  condition: z
    .object({
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
      risk: z.string().optional(),
      category: z.string().optional(),
    })
    .default({}),
});

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withRepositoryAccess(id, async () => {
    const db = await getDb();
    const rows = await db.select().from(policyRules).where(eq(policyRules.repositoryId, id));
    return NextResponse.json({ rules: rows.length > 0 ? rows : DEFAULT_POLICY_RULES });
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withRepositoryAccess(id, async () => {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid rule' }, { status: 400 });
    const db = await getDb();
    const [row] = await db
      .insert(policyRules)
      .values({
        repositoryId: id,
        name: parsed.data.name,
        trigger: parsed.data.trigger,
        action: parsed.data.action,
        condition: parsed.data.condition,
      })
      .returning();
    return NextResponse.json({ rule: row });
  });
}
