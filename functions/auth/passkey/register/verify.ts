import type { Env } from '../../../_shared/session'
import { registrationVerify } from '../../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => registrationVerify(request, env)
