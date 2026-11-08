import type { Env } from '../../../_shared/session'
import { listCredentials } from '../../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => listCredentials(request, env)
