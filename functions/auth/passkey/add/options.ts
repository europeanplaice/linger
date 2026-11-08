import type { Env } from '../../../_shared/session'
import { addOptions } from '../../../_shared/passkeys'

export const onRequestPost: PagesFunction<Env> = ({ request, env }) => addOptions(request, env)
