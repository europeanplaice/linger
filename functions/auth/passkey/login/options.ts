import type { Env } from '../../../_shared/session'
import { loginOptions } from '../../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => loginOptions(request, env)
