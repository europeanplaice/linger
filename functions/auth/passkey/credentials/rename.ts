import type { Env } from '../../../_shared/session'
import { renameCredential } from '../../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => renameCredential(request, env)
