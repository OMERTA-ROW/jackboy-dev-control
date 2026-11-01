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
      owner_projects: {
        Row: {
          active: boolean
          created_at: string
          created_by: string
          description: string
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
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by: string
          description?: string
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
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string
          description?: string
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
      update_proposals: {
        Row: {
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
          status: string
          title: string
          trigger: string
          what_to_change: string
          why: string
        }
        Insert: {
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
          status?: string
          title: string
          trigger?: string
          what_to_change: string
          why: string
        }
        Update: {
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
      update_writer_settings: {
        Row: {
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
