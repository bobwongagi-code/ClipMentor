import { motion } from 'framer-motion'
import { T } from '@/lib/tokens'

type ProgressNodeState = 'shadow' | 'pending' | 'active' | 'done' | 'failed'

interface ProgressNodeProps {
  state: ProgressNodeState
  label: string
  detail?: string
}

export function ProgressNode({ state, label, detail }: ProgressNodeProps) {
  const isActive = state === 'active'
  const isDone = state === 'done'
  const isFailed = state === 'failed'
  const borderColor = isDone ? T.honey : isFailed ? T.red : T.warmInput
  const background = isDone
    ? 'rgba(244,192,78,0.18)'
    : isActive
      ? T.coral
      : isFailed
        ? '#fff4f5'
        : '#fff'

  return (
    <div style={{ width: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, flexShrink: 0 }}>
      <div style={{ position: 'relative', width: 54, height: 54 }}>
        {isActive && (
          <>
            <motion.div
              style={{
                position: 'absolute',
                inset: -11,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(255, 106, 77, 0.18) 0%, rgba(255, 106, 77, 0.10) 42%, rgba(255, 106, 77, 0) 74%)',
                filter: 'blur(1px)',
              }}
              animate={{ scale: [0.96, 1.24, 1.48], opacity: [0.38, 0.18, 0] }}
              transition={{ duration: 1.9, repeat: Infinity, ease: [0.16, 1, 0.3, 1] }}
            />
            <motion.div
              style={{
                position: 'absolute',
                inset: -16,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(244, 192, 78, 0.16) 0%, rgba(244, 192, 78, 0.08) 46%, rgba(244, 192, 78, 0) 76%)',
              }}
              animate={{ scale: [0.9, 1.12, 1.58], opacity: [0, 0.24, 0] }}
              transition={{ duration: 2.35, repeat: Infinity, ease: [0.16, 1, 0.3, 1], delay: 0.42 }}
            />
          </>
        )}
        <motion.div
          style={{
            width: 54,
            height: 54,
            borderRadius: '50%',
            border: isActive ? 'none' : `1px solid ${borderColor}`,
            background,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            zIndex: 1,
            overflow: 'hidden',
            boxShadow: isActive ? '0 0 0 4px rgba(255, 106, 77, 0.12), 0 10px 24px rgba(26,26,26,0.08)' : undefined,
          }}
          animate={isActive ? { scale: [1, 1.016, 1], boxShadow: ['0 0 0 4px rgba(255, 106, 77, 0.08), 0 10px 22px rgba(26,26,26,0.07)', '0 0 0 5px rgba(255, 106, 77, 0.14), 0 13px 28px rgba(26,26,26,0.10)', '0 0 0 4px rgba(255, 106, 77, 0.08), 0 10px 22px rgba(26,26,26,0.07)'] } : undefined}
          transition={isActive ? { duration: 1.65, repeat: Infinity, ease: 'easeInOut' } : undefined}
        >
          {isActive && (
            <motion.div
              style={{
                position: 'absolute',
                inset: -12,
                background: 'linear-gradient(120deg, transparent 20%, rgba(255,255,255,0.22) 48%, transparent 72%)',
                transform: 'rotate(16deg)',
              }}
              animate={{ x: [-32, 34] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
            />
          )}
          {isDone ? (
            <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
              <path d="M1 6L5.5 10.5L15 1" stroke="#B87412" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          ) : isFailed ? (
            <span style={{ color: T.red, fontSize: 18, fontWeight: 700 }}>!</span>
          ) : isActive ? (
            <motion.div
              style={{ width: 16, height: 16, borderRadius: '50%', background: 'rgba(255,255,255,0.98)', boxShadow: '0 0 10px rgba(255,255,255,0.68)' }}
              animate={{ scale: [0.96, 1.03, 0.96], boxShadow: ['0 0 8px rgba(255,255,255,0.62)', '0 0 14px rgba(255,255,255,0.84)', '0 0 8px rgba(255,255,255,0.62)'] }}
              transition={{ duration: 1.45, repeat: Infinity, ease: 'easeInOut' }}
            />
          ) : null}
        </motion.div>
      </div>

      <div style={{ textAlign: 'center', minHeight: 48 }}>
        <div style={{ fontSize: 13, lineHeight: 1.35, color: isActive ? T.text : T.text2, fontWeight: isActive ? 700 : 500 }}>
          {label}
        </div>
        {isActive && detail && (
          <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.35, color: T.text3 }}>
            {detail}
          </div>
        )}
      </div>
    </div>
  )
}
