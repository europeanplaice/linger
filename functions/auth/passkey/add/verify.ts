import type { Env } from '../../../_shared/session'
import { addVerify } from '../../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => addVerify(request, env)
