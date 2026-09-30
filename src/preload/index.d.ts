import type { TerminalManageApi } from '@shared/api'

declare global {
  interface Window {
    api: TerminalManageApi
  }
}

export {}
