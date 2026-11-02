export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      action_requests: {
        Row: {
          action: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          diff_summary: string
          expires_at: string
          id: string
          mode: string | null
          nonce_hash: string
          outcome: string | null
          permissions: string[]
          project_id: string | null
          requested_by: string
          resources: Json
          risk: string
          status: string
          task_id: string | null
          tier: string
        }
        Insert: {
          action: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          diff_summary?: string
          expires_at: string
          id?: string
          mode?: string | null
          nonce_hash: string
          outcome?: string | null
          permissions?: string[]
          project_id?: string | null
          requested_by: string
          resources?: Json
          risk?: string
          status?: string
          task_id?: string | null
          tier: string
        }
        Update: {
          action?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          diff_summary?: string
          expires_at?: string
          id?: string
          mode?: string | null
          nonce_hash?: string
          outcome?: string | null
          permissions?: string[]
          project_id?: string | null
          requested_by?: string
          resources?: Json
          risk?: string
          status?: string
          task_id?: string | null
          tier?: string
        }
        Relationships: []
      }
      agent_memory: {
        Row: {
          branch: string | null
          commit_sha: string | null
          created_at: string
          created_by: string | null
          detail: Json
          id: string
          kind: string
          notion_synced_at: string | null
          project_id: string | null
          repo: string | null
          summary: string
          url: string | null
        }
        Insert: {
          branch?: string | null
          commit_sha?: string | null
          created_at?: string
          created_by?: string | null
          detail?: Json
          id?: string
          kind: string
          notion_synced_at?: string | null
          project_id?: string | null
          repo?: string | null
          summary: string
          url?: string | null
        }
        Update: {
          branch?: string | null
          commit_sha?: string | null
          created_at?: string
          created_by?: string | null
          detail?: Json
          id?: string
          kind?: string
          notion_synced_at?: string | null
          project_id?: string | null
          repo?: string | null
          summary?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_project_tokens: {
        Row: {
          created_at: string
          created_by: string
          id: string
          last_used_at: string | null
          project_id: string
          revoked_at: string | null
          scope: string
          token_hash: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          last_used_at?: string | null
          project_id: string
          revoked_at?: string | null
          scope?: string
          token_hash: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          last_used_at?: string | null
          project_id?: string
          revoked_at?: string | null
          scope?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_project_tokens_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "agent_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_projects: {
        Row: {
          angeltech_enabled: boolean
          created_at: string
          created_by: string
          demontech_enabled: boolean
          enrolled: boolean
          health: string
          id: string
          last_report_at: string | null
          lovable_project_ref: string | null
          name: string
          repo_url: string | null
        }
        Insert: {
          angeltech_enabled?: boolean
          created_at?: string
          created_by: string
          demontech_enabled?: boolean
          enrolled?: boolean
          health?: string
          id?: string
          last_report_at?: string | null
          lovable_project_ref?: string | null
          name: string
          repo_url?: string | null
        }
        Update: {
          angeltech_enabled?: boolean
          created_at?: string
          created_by?: string
          demontech_enabled?: boolean
          enrolled?: boolean
          health?: string
          id?: string
          last_report_at?: string | null
          lovable_project_ref?: string | null
          name?: string
          repo_url?: string | null
        }
        Relationships: []
      }
      agent_proposals: {
        Row: {
          action: string
          created_at: string
          created_by: string
          decided_at: string | null
          decided_by: string | null
          id: string
          pr_url: string | null
          project_id: string
          report_id: string | null
          sensitive: boolean
          status: string
          summary: string
          tests_passed: boolean
          title: string
        }
        Insert: {
          action?: string
          created_at?: string
          created_by: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          pr_url?: string | null
          project_id: string
          report_id?: string | null
          sensitive?: boolean
          status?: string
          summary?: string
          tests_passed?: boolean
          title: string
        }
        Update: {
          action?: string
          created_at?: string
          created_by?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          pr_url?: string | null
          project_id?: string
          report_id?: string | null
          sensitive?: boolean
          status?: string
          summary?: string
          tests_passed?: boolean
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_proposals_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "agent_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_proposals_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "agent_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_reports: {
        Row: {
          agent: string
          agent_id: string | null
          created_at: string
          detail: string
          id: string
          kind: string
          priority: number
          project_id: string
          severity: string
          source_url: string | null
          status: string
          title: string
        }
        Insert: {
          agent: string
          agent_id?: string | null
          created_at?: string
          detail?: string
          id?: string
          kind: string
          priority?: number
          project_id: string
          severity: string
          source_url?: string | null
          status?: string
          title: string
        }
        Update: {
          agent?: string
          agent_id?: string | null
          created_at?: string
          detail?: string
          id?: string
          kind?: string
          priority?: number
          project_id?: string
          severity?: string
          source_url?: string | null
          status?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_reports_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_reports_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "agent_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          adapter: string
          autonomy: string
          category: string
          created_at: string
          created_by: string
          health: string
          id: string
          installed_verified: boolean
          jax_consent_at: string | null
          jax_consent_purpose: string | null
          jax_enrolled: boolean
          last_seen_at: string | null
          model_name: string
          model_provider: string
          name: string
          passport_approved: boolean
          passport_approved_at: string | null
          passport_approved_by: string | null
          paused: boolean
          project_id: string
          specialty: string
        }
        Insert: {
          adapter?: string
          autonomy?: string
          category: string
          created_at?: string
          created_by: string
          health?: string
          id?: string
          installed_verified?: boolean
          jax_consent_at?: string | null
          jax_consent_purpose?: string | null
          jax_enrolled?: boolean
          last_seen_at?: string | null
          model_name?: string
          model_provider?: string
          name: string
          passport_approved?: boolean
          passport_approved_at?: string | null
          passport_approved_by?: string | null
          paused?: boolean
          project_id: string
          specialty?: string
        }
        Update: {
          adapter?: string
          autonomy?: string
          category?: string
          created_at?: string
          created_by?: string
          health?: string
          id?: string
          installed_verified?: boolean
          jax_consent_at?: string | null
          jax_consent_purpose?: string | null
          jax_enrolled?: boolean
          last_seen_at?: string | null
          model_name?: string
          model_provider?: string
          name?: string
          passport_approved?: boolean
          passport_approved_at?: string | null
          passport_approved_by?: string | null
          paused?: boolean
          project_id?: string
          specialty?: string
        }
        Relationships: [
          {
            foreignKeyName: "agents_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "agent_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor: string | null
          at: string
          detail: Json
          id: string
          outcome: string
        }
        Insert: {
          action: string
          actor?: string | null
          at?: string
          detail?: Json
          id?: string
          outcome?: string
        }
        Update: {
          action?: string
          actor?: string | null
          at?: string
          detail?: Json
          id?: string
          outcome?: string
        }
        Relationships: []
      }
      automation_policy: {
        Row: {
          guardian_verified: boolean
          id: number
          max_files: number
          max_lines: number
          paused: boolean
          tier: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          guardian_verified?: boolean
          id?: number
          max_files?: number
          max_lines?: number
          paused?: boolean
          tier?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          guardian_verified?: boolean
          id?: number
          max_files?: number
          max_lines?: number
          paused?: boolean
          tier?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      capability_grants: {
        Row: {
          account: string | null
          approved_at: string | null
          approved_by: string | null
          capability: string
          expires_at: string | null
          id: string
          last_error: string | null
          last_verified_at: string | null
          method: string
          paused: boolean
          project_id: string
          scopes: string
          status: string
          updated_at: string
          verify_attempts: number
        }
        Insert: {
          account?: string | null
          approved_at?: string | null
          approved_by?: string | null
          capability: string
          expires_at?: string | null
          id?: string
          last_error?: string | null
          last_verified_at?: string | null
          method?: string
          paused?: boolean
          project_id: string
          scopes?: string
          status?: string
          updated_at?: string
          verify_attempts?: number
        }
        Update: {
          account?: string | null
          approved_at?: string | null
          approved_by?: string | null
          capability?: string
          expires_at?: string | null
          id?: string
          last_error?: string | null
          last_verified_at?: string | null
          method?: string
          paused?: boolean
          project_id?: string
          scopes?: string
          status?: string
          updated_at?: string
          verify_attempts?: number
        }
        Relationships: [
          {
            foreignKeyName: "capability_grants_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          channel: string
          description: string
          enabled: boolean
          id: string
          key: string
          project_id: string
          rollout_percent: number
          updated_at: string
        }
        Insert: {
          channel: string
          description?: string
          enabled?: boolean
          id?: string
          key: string
          project_id: string
          rollout_percent?: number
          updated_at?: string
        }
        Update: {
          channel?: string
          description?: string
          enabled?: boolean
          id?: string
          key?: string
          project_id?: string
          rollout_percent?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "feature_flags_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      feed_items: {
        Row: {
          created_at: string
          dedupe_key: string
          id: string
          project_ids: string[]
          published_at: string | null
          source_id: string
          summary: string
          title: string
          url: string | null
        }
        Insert: {
          created_at?: string
          dedupe_key: string
          id?: string
          project_ids?: string[]
          published_at?: string | null
          source_id: string
          summary?: string
          title: string
          url?: string | null
        }
        Update: {
          created_at?: string
          dedupe_key?: string
          id?: string
          project_ids?: string[]
          published_at?: string | null
          source_id?: string
          summary?: string
          title?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "feed_items_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "feed_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      feed_sources: {
        Row: {
          active: boolean
          created_at: string
          created_by: string
          id: string
          kind: string
          last_checked_at: string | null
          last_error: string | null
          last_hash: string | null
          name: string
          project_ids: string[]
          token_hash: string | null
          url: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by: string
          id?: string
          kind: string
          last_checked_at?: string | null
          last_error?: string | null
          last_hash?: string | null
          name: string
          project_ids?: string[]
          token_hash?: string | null
          url?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string
          id?: string
          kind?: string
          last_checked_at?: string | null
          last_error?: string | null
          last_hash?: string | null
          name?: string
          project_ids?: string[]
          token_hash?: string | null
          url?: string | null
        }
        Relationships: []
      }
      finding_decisions: {
        Row: {
          created_at: string
          decided_by: string | null
          decision: string
          finding_key: string
          id: string
          message: string
          project_id: string
          proposal_id: string | null
        }
        Insert: {
          created_at?: string
          decided_by?: string | null
          decision: string
          finding_key: string
          id?: string
          message?: string
          project_id: string
          proposal_id?: string | null
        }
        Update: {
          created_at?: string
          decided_by?: string | null
          decision?: string
          finding_key?: string
          id?: string
          message?: string
          project_id?: string
          proposal_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "finding_decisions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      foundry_events: {
        Row: {
          action: string
          actor: string
          created_at: string
          detail: Json
          from_state: string | null
          id: string
          note: string
          project_id: string | null
          task_id: string | null
          to_state: string | null
        }
        Insert: {
          action: string
          actor: string
          created_at?: string
          detail?: Json
          from_state?: string | null
          id?: string
          note?: string
          project_id?: string | null
          task_id?: string | null
          to_state?: string | null
        }
        Update: {
          action?: string
          actor?: string
          created_at?: string
          detail?: Json
          from_state?: string | null
          id?: string
          note?: string
          project_id?: string | null
          task_id?: string | null
          to_state?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "foundry_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "foundry_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      foundry_packages: {
        Row: {
          created_at: string
          id: string
          manifest: Json
          package_sha256: string
          project_id: string | null
          task_id: string
          version: string
        }
        Insert: {
          created_at?: string
          id?: string
          manifest: Json
          package_sha256: string
          project_id?: string | null
          task_id: string
          version: string
        }
        Update: {
          created_at?: string
          id?: string
          manifest?: Json
          package_sha256?: string
          project_id?: string | null
          task_id?: string
          version?: string
        }
        Relationships: []
      }
      foundry_patterns: {
        Row: {
          created_at: string
          description: string
          id: string
          key: string
          last_task_id: string | null
          license: string | null
          license_ok: boolean
          origin: string
          score: number
          source_url: string | null
          tags: string[]
          title: string
          updated_at: string
          verified_count: number
        }
        Insert: {
          created_at?: string
          description?: string
          id?: string
          key: string
          last_task_id?: string | null
          license?: string | null
          license_ok?: boolean
          origin?: string
          score?: number
          source_url?: string | null
          tags?: string[]
          title: string
          updated_at?: string
          verified_count?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          key?: string
          last_task_id?: string | null
          license?: string | null
          license_ok?: boolean
          origin?: string
          score?: number
          source_url?: string | null
          tags?: string[]
          title?: string
          updated_at?: string
          verified_count?: number
        }
        Relationships: []
      }
      foundry_schedule: {
        Row: {
          daily_task_quota: number
          enabled: boolean
          id: number
          interval_hours: number
          last_project_id: string | null
          last_run_at: string | null
          last_tick_at: string | null
          last_tick_result: Json
          max_in_flight: number
          max_runs_per_day: number
          paused: boolean
          runs_day: string | null
          runs_today: number
          updated_at: string
        }
        Insert: {
          daily_task_quota?: number
          enabled?: boolean
          id?: number
          interval_hours?: number
          last_project_id?: string | null
          last_run_at?: string | null
          last_tick_at?: string | null
          last_tick_result?: Json
          max_in_flight?: number
          max_runs_per_day?: number
          paused?: boolean
          runs_day?: string | null
          runs_today?: number
          updated_at?: string
        }
        Update: {
          daily_task_quota?: number
          enabled?: boolean
          id?: number
          interval_hours?: number
          last_project_id?: string | null
          last_run_at?: string | null
          last_tick_at?: string | null
          last_tick_result?: Json
          max_in_flight?: number
          max_runs_per_day?: number
          paused?: boolean
          runs_day?: string | null
          runs_today?: number
          updated_at?: string
        }
        Relationships: []
      }
      foundry_tasks: {
        Row: {
          approved_action: string | null
          attempts: number
          blocked_reason: string | null
          branch: string | null
          commit_sha: string | null
          created_at: string
          created_by: string | null
          dedupe_key: string
          files: Json
          id: string
          idempotency_key: string | null
          kind: string
          max_attempts: number
          needs_capability: string | null
          next_attempt_at: string | null
          paused: boolean
          pr_number: number | null
          pr_url: string | null
          priority: number
          project_id: string
          repo: string | null
          risk: string
          source: string
          state: string
          summary: string
          test_evidence: Json
          title: string
          updated_at: string
        }
        Insert: {
          approved_action?: string | null
          attempts?: number
          blocked_reason?: string | null
          branch?: string | null
          commit_sha?: string | null
          created_at?: string
          created_by?: string | null
          dedupe_key: string
          files?: Json
          id?: string
          idempotency_key?: string | null
          kind?: string
          max_attempts?: number
          needs_capability?: string | null
          next_attempt_at?: string | null
          paused?: boolean
          pr_number?: number | null
          pr_url?: string | null
          priority?: number
          project_id: string
          repo?: string | null
          risk?: string
          source?: string
          state?: string
          summary?: string
          test_evidence?: Json
          title: string
          updated_at?: string
        }
        Update: {
          approved_action?: string | null
          attempts?: number
          blocked_reason?: string | null
          branch?: string | null
          commit_sha?: string | null
          created_at?: string
          created_by?: string | null
          dedupe_key?: string
          files?: Json
          id?: string
          idempotency_key?: string | null
          kind?: string
          max_attempts?: number
          needs_capability?: string | null
          next_attempt_at?: string | null
          paused?: boolean
          pr_number?: number | null
          pr_url?: string | null
          priority?: number
          project_id?: string
          repo?: string | null
          risk?: string
          source?: string
          state?: string
          summary?: string
          test_evidence?: Json
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "foundry_tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      github_installations: {
        Row: {
          account_login: string
          account_type: string
          approved_by: string | null
          created_at: string
          installation_id: number
          missing_permissions: string[]
          permissions: Json
          repositories: string[]
          revoked: boolean
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          account_login: string
          account_type?: string
          approved_by?: string | null
          created_at?: string
          installation_id: number
          missing_permissions?: string[]
          permissions?: Json
          repositories?: string[]
          revoked?: boolean
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          account_login?: string
          account_type?: string
          approved_by?: string | null
          created_at?: string
          installation_id?: number
          missing_permissions?: string[]
          permissions?: Json
          repositories?: string[]
          revoked?: boolean
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      health_reports: {
        Row: {
          channel: string
          created_at: string
          device_hash: string
          id: string
          kind: string
          message: string
          project_id: string
          release_id: string | null
          version: string
        }
        Insert: {
          channel: string
          created_at?: string
          device_hash: string
          id?: string
          kind: string
          message?: string
          project_id: string
          release_id?: string | null
          version: string
        }
        Update: {
          channel?: string
          created_at?: string
          device_hash?: string
          id?: string
          kind?: string
          message?: string
          project_id?: string
          release_id?: string | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "health_reports_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "health_reports_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: false
            referencedRelation: "releases"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: Database["public"]["Enums"]["app_role"]
          status: string
          token_hash: string | null
          used_at: string | null
        }
        Insert: {
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
          token_hash?: string | null
          used_at?: string | null
        }
        Update: {
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
          token_hash?: string | null
          used_at?: string | null
        }
        Relationships: []
      }
      learning_events: {
        Row: {
          created_at: string
          created_by: string
          detail: Json
          id: string
          kind: string
          outcome: string
          project_id: string
          summary: string
        }
        Insert: {
          created_at?: string
          created_by: string
          detail?: Json
          id?: string
          kind: string
          outcome?: string
          project_id: string
          summary: string
        }
        Update: {
          created_at?: string
          created_by?: string
          detail?: Json
          id?: string
          kind?: string
          outcome?: string
          project_id?: string
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "learning_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "agent_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      log_outbox: {
        Row: {
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          log_id: string
          next_attempt_at: string
          sent_at: string | null
          status: string
          target: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          log_id: string
          next_attempt_at?: string
          sent_at?: string | null
          status?: string
          target: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          log_id?: string
          next_attempt_at?: string
          sent_at?: string | null
          status?: string
          target?: string
        }
        Relationships: [
          {
            foreignKeyName: "log_outbox_log_id_fkey"
            columns: ["log_id"]
            isOneToOne: false
            referencedRelation: "site_log"
            referencedColumns: ["id"]
          },
        ]
      }
      log_subscriptions: {
        Row: {
          categories: string[]
          enabled: boolean
          target: string
          updated_at: string
        }
        Insert: {
          categories?: string[]
          enabled?: boolean
          target: string
          updated_at?: string
        }
        Update: {
          categories?: string[]
          enabled?: boolean
          target?: string
          updated_at?: string
        }
        Relationships: []
      }
      omni_jobs: {
        Row: {
          created_at: string
          created_by: string
          guardian_verdict: string
          id: string
          instructions: string
          kind: string
          project_id: string
          report_id: string | null
          sent_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          created_by: string
          guardian_verdict?: string
          id?: string
          instructions?: string
          kind: string
          project_id: string
          report_id?: string | null
          sent_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          guardian_verdict?: string
          id?: string
          instructions?: string
          kind?: string
          project_id?: string
          report_id?: string | null
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "omni_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "agent_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "omni_jobs_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "agent_reports"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_notifications: {
        Row: {
          created_at: string
          email_state: string
          id: string
          kind: string
          message: string
          proposal_id: string | null
          read: boolean
        }
        Insert: {
          created_at?: string
          email_state?: string
          id?: string
          kind: string
          message: string
          proposal_id?: string | null
          read?: boolean
        }
        Update: {
          created_at?: string
          email_state?: string
          id?: string
          kind?: string
          message?: string
          proposal_id?: string | null
          read?: boolean
        }
        Relationships: []
      }
      owner_passkeys: {
        Row: {
          counter: number
          created_at: string
          credential_id: string
          id: string
          label: string
          last_used_at: string | null
          public_key: string
          rp_id: string | null
          transports: string[]
          user_id: string
        }
        Insert: {
          counter?: number
          created_at?: string
          credential_id: string
          id?: string
          label?: string
          last_used_at?: string | null
          public_key: string
          rp_id?: string | null
          transports?: string[]
          user_id: string
        }
        Update: {
          counter?: number
          created_at?: string
          credential_id?: string
          id?: string
          label?: string
          last_used_at?: string | null
          public_key?: string
          rp_id?: string | null
          transports?: string[]
          user_id?: string
        }
        Relationships: []
      }
      owner_projects: {
        Row: {
          active: boolean
          autopilot: boolean
          client_key: string
          connect_error: string | null
          connect_pr_url: string | null
          connect_state: string
          created_at: string
          created_by: string
          demo_detection: boolean
          description: string
          dev_enabled: boolean
          dev_priority: number
          frequency_hours: number
          github_branch: string
          github_repo: string | null
          goals: string
          id: string
          last_proposal_at: string | null
          last_run_at: string | null
          lovable_url: string | null
          name: string
          notes: string
          repair_policy: string
          site_checked_at: string | null
          site_evidence: Json
          site_fail_count: number
          site_monitoring: boolean
          site_next_check_at: string | null
          site_status: string
          site_url: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          autopilot?: boolean
          client_key?: string
          connect_error?: string | null
          connect_pr_url?: string | null
          connect_state?: string
          created_at?: string
          created_by: string
          demo_detection?: boolean
          description?: string
          dev_enabled?: boolean
          dev_priority?: number
          frequency_hours?: number
          github_branch?: string
          github_repo?: string | null
          goals?: string
          id?: string
          last_proposal_at?: string | null
          last_run_at?: string | null
          lovable_url?: string | null
          name: string
          notes?: string
          repair_policy?: string
          site_checked_at?: string | null
          site_evidence?: Json
          site_fail_count?: number
          site_monitoring?: boolean
          site_next_check_at?: string | null
          site_status?: string
          site_url?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          autopilot?: boolean
          client_key?: string
          connect_error?: string | null
          connect_pr_url?: string | null
          connect_state?: string
          created_at?: string
          created_by?: string
          demo_detection?: boolean
          description?: string
          dev_enabled?: boolean
          dev_priority?: number
          frequency_hours?: number
          github_branch?: string
          github_repo?: string | null
          goals?: string
          id?: string
          last_proposal_at?: string | null
          last_run_at?: string | null
          lovable_url?: string | null
          name?: string
          notes?: string
          repair_policy?: string
          site_checked_at?: string | null
          site_evidence?: Json
          site_fail_count?: number
          site_monitoring?: boolean
          site_next_check_at?: string | null
          site_status?: string
          site_url?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      playbooks: {
        Row: {
          created_at: string
          created_by: string
          id: string
          steps: string
          title: string
          trigger: string
          verified: boolean
          verified_by: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          steps: string
          title: string
          trigger: string
          verified?: boolean
          verified_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          steps?: string
          title?: string
          trigger?: string
          verified?: boolean
          verified_by?: string | null
        }
        Relationships: []
      }
      razul_feedback: {
        Row: {
          created_at: string
          created_by: string
          finding_id: string
          id: string
          note: string
          outcome: string
          sent_at: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          finding_id: string
          id?: string
          note?: string
          outcome: string
          sent_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          finding_id?: string
          id?: string
          note?: string
          outcome?: string
          sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "razul_feedback_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "razul_findings"
            referencedColumns: ["id"]
          },
        ]
      }
      razul_findings: {
        Row: {
          confidence: number | null
          evidence: string
          field: string
          id: string
          imported_at: string
          imported_by: string
          observed_at: string
          priority: number
          project_id: string | null
          razul_id: string
          sources: Json
          status: string
          summary: string
          title: string
        }
        Insert: {
          confidence?: number | null
          evidence: string
          field?: string
          id?: string
          imported_at?: string
          imported_by: string
          observed_at: string
          priority?: number
          project_id?: string | null
          razul_id: string
          sources: Json
          status?: string
          summary?: string
          title: string
        }
        Update: {
          confidence?: number | null
          evidence?: string
          field?: string
          id?: string
          imported_at?: string
          imported_by?: string
          observed_at?: string
          priority?: number
          project_id?: string | null
          razul_id?: string
          sources?: Json
          status?: string
          summary?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "razul_findings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "agent_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      releases: {
        Row: {
          artifact_path: string | null
          artifact_sha256: string | null
          artifact_size: number | null
          auto_step: number
          channel: string
          config: Json
          created_at: string
          created_by: string
          error_threshold: number
          id: string
          last_step_at: string | null
          manifest: Json | null
          min_reports: number
          notes: string
          project_id: string
          published_at: string | null
          rollback_reason: string | null
          rollout_percent: number
          signature: string | null
          status: string
          step_hours: number
          version: string
        }
        Insert: {
          artifact_path?: string | null
          artifact_sha256?: string | null
          artifact_size?: number | null
          auto_step?: number
          channel: string
          config?: Json
          created_at?: string
          created_by: string
          error_threshold?: number
          id?: string
          last_step_at?: string | null
          manifest?: Json | null
          min_reports?: number
          notes?: string
          project_id: string
          published_at?: string | null
          rollback_reason?: string | null
          rollout_percent?: number
          signature?: string | null
          status?: string
          step_hours?: number
          version: string
        }
        Update: {
          artifact_path?: string | null
          artifact_sha256?: string | null
          artifact_size?: number | null
          auto_step?: number
          channel?: string
          config?: Json
          created_at?: string
          created_by?: string
          error_threshold?: number
          id?: string
          last_step_at?: string | null
          manifest?: Json | null
          min_reports?: number
          notes?: string
          project_id?: string
          published_at?: string | null
          rollback_reason?: string | null
          rollout_percent?: number
          signature?: string | null
          status?: string
          step_hours?: number
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "releases_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      site_log: {
        Row: {
          action: string
          actor: string
          at: string
          branch: string | null
          category: string
          commit_sha: string | null
          detail: Json
          id: string
          issue: string | null
          license: string | null
          pr_url: string | null
          project_id: string | null
          repo: string | null
          source_url: string | null
          status: string
          summary: string
          task_id: string | null
          tests: string | null
        }
        Insert: {
          action: string
          actor: string
          at?: string
          branch?: string | null
          category?: string
          commit_sha?: string | null
          detail?: Json
          id?: string
          issue?: string | null
          license?: string | null
          pr_url?: string | null
          project_id?: string | null
          repo?: string | null
          source_url?: string | null
          status?: string
          summary: string
          task_id?: string | null
          tests?: string | null
        }
        Update: {
          action?: string
          actor?: string
          at?: string
          branch?: string | null
          category?: string
          commit_sha?: string | null
          detail?: Json
          id?: string
          issue?: string | null
          license?: string | null
          pr_url?: string | null
          project_id?: string | null
          repo?: string | null
          source_url?: string | null
          status?: string
          summary?: string
          task_id?: string | null
          tests?: string | null
        }
        Relationships: []
      }
      site_scans: {
        Row: {
          avg_ms: number | null
          created_at: string
          error: string | null
          findings: Json
          finished_at: string | null
          fix_proposal_id: string | null
          id: string
          links_checked: number
          pages_checked: number
          project_id: string
          status: string
          trigger: string
        }
        Insert: {
          avg_ms?: number | null
          created_at?: string
          error?: string | null
          findings?: Json
          finished_at?: string | null
          fix_proposal_id?: string | null
          id?: string
          links_checked?: number
          pages_checked?: number
          project_id: string
          status?: string
          trigger?: string
        }
        Update: {
          avg_ms?: number | null
          created_at?: string
          error?: string | null
          findings?: Json
          finished_at?: string | null
          fix_proposal_id?: string | null
          id?: string
          links_checked?: number
          pages_checked?: number
          project_id?: string
          status?: string
          trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "site_scans_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      step_up_grants: {
        Row: {
          action: string
          created_at: string
          credential_id: string
          expires_at: string
          id: string
          target: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          credential_id: string
          expires_at: string
          id?: string
          target: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          credential_id?: string
          expires_at?: string
          id?: string
          target?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      update_installs: {
        Row: {
          created_at: string
          detail: string
          id: string
          idempotency_key: string
          phase: string
          release_id: string | null
          target_id: string
          version: string
        }
        Insert: {
          created_at?: string
          detail?: string
          id?: string
          idempotency_key: string
          phase: string
          release_id?: string | null
          target_id: string
          version: string
        }
        Update: {
          created_at?: string
          detail?: string
          id?: string
          idempotency_key?: string
          phase?: string
          release_id?: string | null
          target_id?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "update_installs_release_id_fkey"
            columns: ["release_id"]
            isOneToOne: false
            referencedRelation: "releases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "update_installs_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "update_targets"
            referencedColumns: ["id"]
          },
        ]
      }
      update_proposals: {
        Row: {
          autopilot_note: string | null
          branch_name: string | null
          build_prompt: string
          checks_state: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          delivery_error: string | null
          edited: boolean
          feed_item_ids: string[]
          files: Json
          head_sha: string | null
          id: string
          merge_sha: string | null
          model: string | null
          pr_number: number | null
          pr_url: string | null
          project_id: string
          revert_pr_url: string | null
          source: string
          status: string
          title: string
          trigger: string
          what_to_change: string
          why: string
        }
        Insert: {
          autopilot_note?: string | null
          branch_name?: string | null
          build_prompt: string
          checks_state?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          delivery_error?: string | null
          edited?: boolean
          feed_item_ids?: string[]
          files?: Json
          head_sha?: string | null
          id?: string
          merge_sha?: string | null
          model?: string | null
          pr_number?: number | null
          pr_url?: string | null
          project_id: string
          revert_pr_url?: string | null
          source?: string
          status?: string
          title: string
          trigger?: string
          what_to_change: string
          why: string
        }
        Update: {
          autopilot_note?: string | null
          branch_name?: string | null
          build_prompt?: string
          checks_state?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          delivery_error?: string | null
          edited?: boolean
          feed_item_ids?: string[]
          files?: Json
          head_sha?: string | null
          id?: string
          merge_sha?: string | null
          model?: string | null
          pr_number?: number | null
          pr_url?: string | null
          project_id?: string
          revert_pr_url?: string | null
          source?: string
          status?: string
          title?: string
          trigger?: string
          what_to_change?: string
          why?: string
        }
        Relationships: [
          {
            foreignKeyName: "update_proposals_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      update_targets: {
        Row: {
          channel: string
          created_at: string
          created_by: string | null
          current_version: string | null
          id: string
          last_release_id: string | null
          last_seen_at: string | null
          name: string
          platform: string
          project_id: string
          revoked_at: string | null
          state: string
          token_hash: string
        }
        Insert: {
          channel?: string
          created_at?: string
          created_by?: string | null
          current_version?: string | null
          id?: string
          last_release_id?: string | null
          last_seen_at?: string | null
          name: string
          platform?: string
          project_id: string
          revoked_at?: string | null
          state?: string
          token_hash: string
        }
        Update: {
          channel?: string
          created_at?: string
          created_by?: string | null
          current_version?: string | null
          id?: string
          last_release_id?: string | null
          last_seen_at?: string | null
          name?: string
          platform?: string
          project_id?: string
          revoked_at?: string | null
          state?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "update_targets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "owner_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      update_writer_settings: {
        Row: {
          autopilot_enabled: boolean
          frequency_hours: number
          id: number
          last_run_at: string | null
          lock_until: string | null
          monthly_ai_cap: number
          monthly_run_cap: number
          paused_reason: string | null
          updated_at: string
        }
        Insert: {
          autopilot_enabled?: boolean
          frequency_hours?: number
          id?: number
          last_run_at?: string | null
          lock_until?: string | null
          monthly_ai_cap?: number
          monthly_run_cap?: number
          paused_reason?: string | null
          updated_at?: string
        }
        Update: {
          autopilot_enabled?: boolean
          frequency_hours?: number
          id?: number
          last_run_at?: string | null
          lock_until?: string | null
          monthly_ai_cap?: number
          monthly_run_cap?: number
          paused_reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      usage_ledger: {
        Row: {
          at: string
          id: string
          kind: string
          project_id: string | null
        }
        Insert: {
          at?: string
          id?: string
          kind: string
          project_id?: string | null
        }
        Update: {
          at?: string
          id?: string
          kind?: string
          project_id?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webauthn_challenges: {
        Row: {
          action: string | null
          challenge: string
          created_at: string
          expires_at: string
          id: string
          purpose: string
          target: string | null
          used_at: string | null
          user_id: string
        }
        Insert: {
          action?: string | null
          challenge: string
          created_at?: string
          expires_at: string
          id?: string
          purpose: string
          target?: string | null
          used_at?: string | null
          user_id: string
        }
        Update: {
          action?: string | null
          challenge?: string
          created_at?: string
          expires_at?: string
          id?: string
          purpose?: string
          target?: string | null
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invitation: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      approve_passport: {
        Args: { _approve: boolean; _id: string }
        Returns: undefined
      }
      create_invitation: {
        Args: { _email: string; _role: Database["public"]["Enums"]["app_role"] }
        Returns: string
      }
      decide_proposal: {
        Args: { _approve: boolean; _id: string }
        Returns: undefined
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_manager: { Args: { _user_id: string }; Returns: boolean }
      my_role: { Args: never; Returns: Database["public"]["Enums"]["app_role"] }
      remove_member: { Args: { _user_id: string }; Returns: undefined }
      revoke_invitation: { Args: { _id: string }; Returns: undefined }
      set_automation_policy: {
        Args: {
          _max_files: number
          _max_lines: number
          _paused: boolean
          _tier: number
        }
        Returns: undefined
      }
      set_jax_enrollment: {
        Args: { _enroll: boolean; _id: string; _purpose: string }
        Returns: undefined
      }
      write_audit: {
        Args: { _action: string; _detail: Json; _outcome: string }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "owner" | "admin" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["owner", "admin", "member"],
    },
  },
} as const
