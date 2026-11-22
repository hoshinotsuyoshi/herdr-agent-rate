# frozen_string_literal: true

# Run: ruby test/agent_rate_test.rb
#      AR_BIN=/path/to/agent-rate ruby test/agent_rate_test.rb  (against a compiled binary)

require "minitest/autorun"
require "json"
require "open3"
require "tmpdir"
require "fileutils"

SCRIPT = File.expand_path("../bin/agent-rate", __dir__)
CLI = ENV["AR_BIN"] ? [File.expand_path(ENV["AR_BIN"])] : [RbConfig.ruby, SCRIPT]

class AgentRateTest < Minitest::Test
  RATE = {
    "five_hour" => { "used_percentage" => 31.5, "resets_at" => 1_794_600_000 },
    "seven_day" => { "used_percentage" => 8, "resets_at" => 1_795_000_000 },
  }.freeze

  def setup
    @home = Dir.mktmpdir
  end

  def teardown
    FileUtils.rm_rf(@home)
  end

  # HOME and USERPROFILE both, so the home folder is @home on Windows too
  def run_cli(*args, input: "", env: {})
    env = { "HOME" => @home, "USERPROFILE" => @home, "CODEX_HOME" => nil }.merge(env)
    out, err, status = Open3.capture3(env, *CLI, *args, stdin_data: input)
    [out, err, status]
  end

  def statusline(input)
    out, err, status = run_cli("statusline", input: JSON.generate(input))
    assert status.success?, err
    assert_equal "", err
    out
  end

  def codex(env: {})
    out, err, status = run_cli("codex", env: env)
    assert status.success?, err
    assert_equal "", err
    JSON.parse(out)
  end

  def rate_file = File.join(@home, ".cache", "claude", "rate-limits.json")
  def agy_rate_file = File.join(@home, ".cache", "antigravity", "rate-limits.json")

  # A Codex session log under <codex_home>/sessions/YYYY/MM/DD with the given token_count rate limits
  def codex_log(name, *limits, codex_home: File.join(@home, ".codex"), mtime: nil)
    dir = File.join(codex_home, "sessions", "2026", "11", "15")
    FileUtils.mkdir_p(dir)
    path = File.join(dir, "rollout-#{name}.jsonl")
    lines = [JSON.generate({ "type" => "session_meta", "payload" => { "id" => name } })]
    limits.each do |l|
      lines << JSON.generate({ "type" => "event_msg", "payload" => { "type" => "token_count", "rate_limits" => l } })
      lines << JSON.generate({ "type" => "response_item", "payload" => { "type" => "message" } })
    end
    File.write(path, lines.join("\n") + "\n")
    File.utime(mtime, mtime, path) if mtime
    path
  end

  def limits(five, week)
    {
      "limit_id" => "codex",
      "primary" => { "used_percent" => five, "window_minutes" => 300, "resets_at" => 1_794_600_000 },
      "secondary" => { "used_percent" => week, "window_minutes" => 10_080, "resets_at" => 1_795_000_000 },
    }
  end

  def shaped(five, week)
    {
      "five_hour" => { "used_percentage" => five, "resets_at" => 1_794_600_000 },
      "seven_day" => { "used_percentage" => week, "resets_at" => 1_795_000_000 },
    }
  end

  def test_usage
    out, err, status = run_cli
    assert_equal 2, status.exitstatus
    assert_equal "", out
    assert_includes err, "usage: agent-rate statusline | agent-rate codex"
  end

  def test_statusline_prints_model_and_context
    out = statusline(
      "model" => { "display_name" => "Opus 5.5" },
      "context_window" => {
        "context_window_size" => 1_000_000, "used_percentage" => 12,
        "current_usage" => { "input_tokens" => 5, "cache_creation_input_tokens" => 1200, "cache_read_input_tokens" => 118_000 },
      },
    )
    assert_equal "Opus 5.5 | ctx 119k / 1000k (12%)\n", out
  end

  def test_statusline_missing_fields_print_zero
    assert_equal " | ctx 0k / 0k (0%)\n", statusline({})
  end

  def test_statusline_writes_rate_limits_with_updated_at
    before = Time.now.to_i
    statusline("model" => { "display_name" => "x" }, "rate_limits" => RATE)
    saved = JSON.parse(File.read(rate_file))
    assert_equal RATE, saved.except("updated_at")
    assert_includes before..(Time.now.to_i), saved["updated_at"]
    assert_equal ["rate-limits.json"], Dir.children(File.dirname(rate_file))
  end

  # On Windows a rename onto an existing file is not a given
  def test_statusline_replaces_the_previous_rate_limits
    statusline("rate_limits" => RATE)
    newer = { "five_hour" => { "used_percentage" => 50, "resets_at" => 1_794_600_000 } }
    statusline("rate_limits" => newer)
    assert_equal newer, JSON.parse(File.read(rate_file)).except("updated_at")
    assert_equal ["rate-limits.json"], Dir.children(File.dirname(rate_file))
  end

  def test_statusline_without_rate_limits_leaves_the_file_alone
    statusline("rate_limits" => RATE)
    kept = File.read(rate_file)
    statusline("model" => { "display_name" => "x" })
    assert_equal kept, File.read(rate_file)
  end

  def test_statusline_writes_antigravity_quota
    before = Time.now.to_i
    statusline(
      "product" => "antigravity",
      "model" => { "display_name" => "Gemini 3.8 Flash (Medium)" },
      "context_window" => { "context_window_size" => 1_048_576, "used_percentage" => 5 },
      "quota" => {
        "gemini-weekly" => {
          "remaining_fraction" => 0.85,
          "reset_time" => "2026-11-29T12:00:00Z",
          "reset_in_seconds" => 576_000,
        },
        "gemini-5h" => {
          "remaining_fraction" => 0.4,
          "reset_in_seconds" => 10_800,
        },
      },
    )
    saved = JSON.parse(File.read(agy_rate_file))
    expected_week_resets = Time.utc(2026, 11, 29, 12, 0, 0).to_i
    assert_equal 15.0, saved.dig("seven_day", "used_percentage")
    assert_equal expected_week_resets, saved.dig("seven_day", "resets_at")
    assert_equal 60.0, saved.dig("five_hour", "used_percentage")
    assert_includes (before + 10_800)..(Time.now.to_i + 10_800), saved.dig("five_hour", "resets_at")
    assert_includes before..(Time.now.to_i), saved["updated_at"]
    assert_equal ["rate-limits.json"], Dir.children(File.dirname(agy_rate_file))
  end

  def test_statusline_selects_only_exact_gemini_quotas
    quota = {
      "3p-5h" => { "remaining_fraction" => 1, "reset_time" => "2026-11-22T23:06:13Z", "reset_in_seconds" => 17_992 },
      "3p-weekly" => { "remaining_fraction" => 1, "reset_time" => "2026-11-29T18:06:13Z", "reset_in_seconds" => 604_792 },
      "gemini-5h" => { "remaining_fraction" => 0.60508156, "reset_time" => "2026-11-22T18:24:17Z", "reset_in_seconds" => 1_076 },
      "gemini-argon-wtu-weekly" => { "remaining_fraction" => 1, "reset_time" => "2026-11-29T18:06:13Z", "reset_in_seconds" => 604_792 },
      "gemini-weekly" => { "remaining_fraction" => 0.8884222, "reset_time" => "2026-11-29T13:24:17Z", "reset_in_seconds" => 587_876 },
    }
    expected = {
      "five_hour" => { "used_percentage" => 39.5, "resets_at" => Time.utc(2026, 11, 22, 18, 24, 17).to_i },
      "seven_day" => { "used_percentage" => 11.2, "resets_at" => Time.utc(2026, 11, 29, 13, 24, 17).to_i },
    }

    [quota, quota.to_a.reverse.to_h].each do |ordered_quota|
      statusline("quota" => ordered_quota)
      assert_equal expected, JSON.parse(File.read(agy_rate_file)).except("updated_at")
    end
  end

  def test_statusline_with_only_one_exact_gemini_quota
    {
      "gemini-5h" => ["five_hour", 60.0],
      "gemini-weekly" => ["seven_day", 15.0],
    }.each do |name, (key, used)|
      statusline("quota" => {
        "3p-5h" => { "remaining_fraction" => 0, "reset_in_seconds" => 100 },
        name => { "remaining_fraction" => 1.0 - used / 100, "reset_in_seconds" => 3_600 },
      })
      saved = JSON.parse(File.read(agy_rate_file)).except("updated_at")
      assert_equal [key], saved.keys
      assert_equal used, saved.dig(key, "used_percentage")
    end
  end

  def test_statusline_unwritable_home_still_prints
    File.write(File.join(@home, ".cache"), "a file, not a directory")
    assert_equal "x | ctx 0k / 0k (0%)\n", statusline("model" => { "display_name" => "x" }, "rate_limits" => RATE)
  end

  def test_codex_without_logs_prints_empty
    assert_equal({}, codex)
  end

  def test_codex_takes_the_last_rate_limits_of_the_newest_log
    now = Time.now.to_i
    codex_log("old", limits(90.0, 50.0), mtime: now - 60)
    codex_log("new", limits(10.0, 20.0), limits(12.0, 21.0), mtime: now)
    assert_equal shaped(12.0, 21.0), codex
  end

  def test_codex_goes_by_mtime_not_by_name
    now = Time.now.to_i
    codex_log("2026-11-15T09-00-00", limits(1.0, 2.0), mtime: now - 60)
    codex_log("2026-11-10T09-00-00", limits(30.0, 40.0), mtime: now)
    assert_equal shaped(30.0, 40.0), codex
  end

  def test_codex_skips_a_new_log_without_rate_limits
    now = Time.now.to_i
    codex_log("older", limits(5.0, 6.0), mtime: now - 60)
    codex_log("just-started", mtime: now)
    assert_equal shaped(5.0, 6.0), codex
  end

  def test_codex_tells_windows_apart_by_length
    now = Time.now.to_i
    swapped = limits(7.0, 8.0)
    swapped["primary"], swapped["secondary"] = swapped["secondary"], swapped["primary"]
    swapped["secondary"] = nil
    codex_log("x", swapped, mtime: now)
    assert_equal({ "seven_day" => { "used_percentage" => 8.0, "resets_at" => 1_795_000_000 } }, codex)
  end

  def test_codex_home_from_env
    other = File.join(@home, "elsewhere")
    codex_log("x", limits(3.0, 4.0), codex_home: other)
    assert_equal({}, codex)
    assert_equal shaped(3.0, 4.0), codex(env: { "CODEX_HOME" => other })
  end
end
