locals {
  s3_workflows_bundle_path = abspath("${path.root}/${var.s3_workflows_bundle_path}")

  s3_workflow_targets = {
    production = {
      worker_name           = var.s3_workflows_worker_prefix
      workflow_name         = "${var.s3_workflow_name}-production"
      mirror_workflow_name  = "${var.s3_mirror_workflow_name}-production"
      sessions_namespace_id = cloudflare_workers_kv_namespace.sessions.id
    }
    preview = {
      worker_name           = "${var.s3_workflows_worker_prefix}-preview"
      workflow_name         = "${var.s3_workflow_name}-preview"
      mirror_workflow_name  = "${var.s3_mirror_workflow_name}-preview"
      sessions_namespace_id = cloudflare_workers_kv_namespace.sessions_preview.id
    }
    staging = {
      worker_name           = "${var.s3_workflows_worker_prefix}-staging"
      workflow_name         = "${var.s3_workflow_name}-staging"
      mirror_workflow_name  = "${var.s3_mirror_workflow_name}-staging"
      sessions_namespace_id = cloudflare_workers_kv_namespace.sessions_staging.id
    }
  }
}

resource "cloudflare_workers_script" "s3_workflows" {
  for_each = local.s3_workflow_targets

  account_id     = var.cloudflare_account_id
  script_name    = each.value.worker_name
  content_file   = local.s3_workflows_bundle_path
  content_sha256 = fileexists(local.s3_workflows_bundle_path) ? filesha256(local.s3_workflows_bundle_path) : ""
  main_module    = "index.js"

  compatibility_date  = "2026-08-01"
  compatibility_flags = ["nodejs_compat"]
  keep_bindings       = ["secret_text"]

  bindings = [
    {
      name         = "SESSIONS"
      type         = "kv_namespace"
      namespace_id = each.value.sessions_namespace_id
    },
    {
      class_name = "S3SyncIndex"
      name       = "S3_SYNC_INDEX"
      type       = "durable_object_namespace"
    },
    {
      name          = "S3_BACKFILL_WORKFLOW"
      script_name   = each.value.worker_name
      type          = "workflow"
      workflow_name = each.value.workflow_name
    },
    {
      name          = "S3_MIRROR_WORKFLOW"
      script_name   = each.value.worker_name
      type          = "workflow"
      workflow_name = each.value.mirror_workflow_name
    }
  ]

  observability = {
    enabled            = true
    head_sampling_rate = 1
  }

  lifecycle {
    precondition {
      condition     = fileexists(local.s3_workflows_bundle_path)
      error_message = "Build the Worker bundle first with 'npm run build:workflows:bundle'."
    }
  }
}

resource "cloudflare_workflow" "s3_backfill" {
  for_each = cloudflare_workers_script.s3_workflows

  account_id    = var.cloudflare_account_id
  workflow_name = local.s3_workflow_targets[each.key].workflow_name
  class_name    = "S3BackfillWorkflow"
  script_name   = each.value.script_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workflow" "s3_mirror" {
  for_each = cloudflare_workers_script.s3_workflows

  account_id    = var.cloudflare_account_id
  workflow_name = local.s3_workflow_targets[each.key].mirror_workflow_name
  class_name    = "S3MirrorWorkflow"
  script_name   = each.value.script_name

  lifecycle {
    prevent_destroy = true
  }
}
