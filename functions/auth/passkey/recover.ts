import type { Env } from '../../_shared/session'
import { recoverSession } from '../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => recoverSession(request, env)
