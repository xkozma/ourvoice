import { spawn } from 'node:child_process'

const isRender = process.env.RENDER === 'true'

const command = isRender
  ? ['npm', ['run', 'start', '--prefix', 'backend']]
  : ['npm', ['run', 'dev:local']]

const child = spawn(command[0], command[1], {
  shell: true,
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})

child.on('error', () => {
  process.exit(1)
})
