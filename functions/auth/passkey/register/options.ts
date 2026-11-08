import type { Env } from '../../../_shared/session'
import { registrationOptions } from '../../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => registrationOptions(request, env)
