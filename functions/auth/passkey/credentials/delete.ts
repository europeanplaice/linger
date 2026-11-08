import type { Env } from '../../../_shared/session'
import { deleteCredential } from '../../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => deleteCredential(request, env)
