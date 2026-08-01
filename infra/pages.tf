# __generated__ by Terraform
# Please review these resources and move them into your main configuration files.

# __generated__ by Terraform from "02f7b8fd5c6823c05eca881e78cd298c/linger"
resource "cloudflare_pages_project" "linger" {
  account_id        = var.cloudflare_account_id
  name              = "linger"
  production_branch = "main"
  build_config = {
    build_caching       = false
    build_command       = null
    destination_dir     = "dist"
    root_dir            = null
    web_analytics_tag   = null
    web_analytics_token = null
  }
  deployment_configs = {
    preview = {
      always_use_latest_compatibility_date = false
      compatibility_date                   = "2024-11-01"
      compatibility_flags                  = []
      d1_databases                         = {}
      durable_object_namespaces            = {}
      fail_open                            = true
      kv_namespaces = {
        SESSIONS = {
          namespace_id = cloudflare_workers_kv_namespace.sessions_preview.id
        }
      }
      services = {
        S3_WORKFLOW_SERVICE = {
          service = "${var.s3_workflows_worker_prefix}-preview"
        }
      }
      r2_buckets = {}
    }
    production = {
      always_use_latest_compatibility_date = false
      compatibility_date                   = "2024-11-01"
      compatibility_flags                  = []
      d1_databases                         = {}
      durable_object_namespaces            = {}
      fail_open                            = true
      kv_namespaces = {
        SESSIONS = {
          namespace_id = cloudflare_workers_kv_namespace.sessions.id
        }
      }
      services = {
        S3_WORKFLOW_SERVICE = {
          service = var.s3_workflows_worker_prefix
        }
      }
      r2_buckets = {}
    }
  }

  lifecycle {
    ignore_changes = [
      deployment_configs.preview.env_vars,
      deployment_configs.production.env_vars,
    ]
  }
}

# __generated__ by Terraform from "02f7b8fd5c6823c05eca881e78cd298c/linger/linger.europeanplaice.com"
resource "cloudflare_pages_domain" "linger" {
  account_id   = var.cloudflare_account_id
  name         = "linger.europeanplaice.com"
  project_name = "linger"
}

resource "cloudflare_pages_project" "linger_staging" {
  account_id        = var.cloudflare_account_id
  name              = "linger-staging"
  production_branch = "staging"
  build_config = {
    build_caching       = false
    build_command       = null
    destination_dir     = "dist"
    root_dir            = null
    web_analytics_tag   = null
    web_analytics_token = null
  }
  deployment_configs = {
    preview = {
      always_use_latest_compatibility_date = false
      compatibility_date                   = "2024-11-01"
      compatibility_flags                  = []
      d1_databases                         = {}
      durable_object_namespaces            = {}
      fail_open                            = true
      kv_namespaces = {
        SESSIONS = {
          namespace_id = cloudflare_workers_kv_namespace.sessions_staging.id
        }
      }
      services = {
        S3_WORKFLOW_SERVICE = {
          service = "${var.s3_workflows_worker_prefix}-staging"
        }
      }
      r2_buckets = {}
    }
    production = {
      always_use_latest_compatibility_date = false
      compatibility_date                   = "2024-11-01"
      compatibility_flags                  = []
      d1_databases                         = {}
      durable_object_namespaces            = {}
      fail_open                            = true
      kv_namespaces = {
        SESSIONS = {
          namespace_id = cloudflare_workers_kv_namespace.sessions_staging.id
        }
      }
      services = {
        S3_WORKFLOW_SERVICE = {
          service = "${var.s3_workflows_worker_prefix}-staging"
        }
      }
      r2_buckets = {}
    }
  }

  lifecycle {
    ignore_changes = [
      deployment_configs.preview.env_vars,
      deployment_configs.production.env_vars,
    ]
  }
}

resource "cloudflare_pages_domain" "linger_staging" {
  account_id   = var.cloudflare_account_id
  name         = "staging.linger.europeanplaice.com"
  project_name = cloudflare_pages_project.linger_staging.name
}
