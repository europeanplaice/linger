import type { Env } from '../../../_shared/session'
import { loginVerify } from '../../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => loginVerify(request, env)
