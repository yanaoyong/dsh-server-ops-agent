import { readFileSync } from 'node:fs'
export const inject = ['tools']
export function apply(ctx) {
  const evidence = JSON.parse(
    readFileSync(process.env.SERVER_OPS_EVIDENCE, 'utf8')
  )
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'read_ops_event',
        description: 'Read the observations assigned to this investigation.',
        parameters: {
          type: 'object',
          properties: { event: { type: 'string', enum: [evidence.event] } },
          required: ['event'],
          additionalProperties: false
        },
        output: {
          schema: { type: 'object' },
          render: (_, data) => [{ type: 'text', text: JSON.stringify(data) }]
        },
        execute({ event }) {
          if (event !== evidence.event) throw Error('事件不匹配')
          return evidence
        }
      }),
    '事件证据'
  )
}
