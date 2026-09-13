#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "driver/gpio.h"
#include "esp_crt_bundle.h"
#include "esp_check.h"
#include "esp_err.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_sntp.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mbedtls/md.h"
#include "nvs.h"
#include "nvs_flash.h"

#define SWITCH_LEFT_GPIO GPIO_NUM_3
#define SWITCH_RIGHT_GPIO GPIO_NUM_4
#define SAMPLE_INTERVAL_MS 10
#define DEBOUNCE_SAMPLES 8
#define WIFI_CONNECTED_BIT BIT0
#define CONFIG_MAGIC 0x54535731U
#define STATE_MAGIC 0x54535331U
#define STORAGE_VERSION 1U
#define MAX_PENDING_OPERATIONS 16

typedef enum {
  SWITCH_LEFT,
  SWITCH_CLOCKED_OUT,
  SWITCH_RIGHT,
  SWITCH_INVALID,
} switch_state_t;

typedef enum {
  OPERATION_START = 1,
  OPERATION_STOP = 2,
} operation_type_t;

typedef struct {
  uint8_t type;
  char session_id[37];
  char company_id[37];
  int64_t occurred_at;
} pending_operation_t;

typedef struct {
  uint32_t magic;
  uint16_t version;
  char wifi_ssid[33];
  char wifi_password[65];
  char api_url[161];
  char device_id[33];
  char device_secret[129];
  char left_company_id[37];
  char right_company_id[37];
} device_config_t;

typedef struct {
  uint32_t magic;
  uint16_t version;
  uint8_t operation_count;
  uint8_t last_switch_state;
  char active_session_id[37];
  pending_operation_t operations[MAX_PENDING_OPERATIONS];
} persistent_state_t;

static const char *TAG = "time_switch";
static const char *NVS_NAMESPACE = "time_switch";
static device_config_t config;
static persistent_state_t state;
static SemaphoreHandle_t state_mutex;
static EventGroupHandle_t wifi_events;
static bool clock_was_ready;

static bool clock_ready(void) {
  time_t now = 0;
  time(&now);
  return now > 1704067200;
}

static const char *switch_state_name(switch_state_t value) {
  switch (value) {
    case SWITCH_LEFT: return "LEFT";
    case SWITCH_CLOCKED_OUT: return "CLOCKED_OUT";
    case SWITCH_RIGHT: return "RIGHT";
    default: return "INVALID";
  }
}

static switch_state_t read_switch(void) {
  const bool left_active = gpio_get_level(SWITCH_LEFT_GPIO) == 0;
  const bool right_active = gpio_get_level(SWITCH_RIGHT_GPIO) == 0;
  if (left_active && !right_active) return SWITCH_LEFT;
  if (!left_active && !right_active) return SWITCH_CLOCKED_OUT;
  if (!left_active && right_active) return SWITCH_RIGHT;
  return SWITCH_INVALID;
}

static esp_err_t open_storage(nvs_handle_t *handle) {
  return nvs_open(NVS_NAMESPACE, NVS_READWRITE, handle);
}

static void load_config(void) {
  memset(&config, 0, sizeof(config));
  nvs_handle_t handle;
  if (open_storage(&handle) != ESP_OK) return;
  size_t length = sizeof(config);
  if (nvs_get_blob(handle, "config", &config, &length) != ESP_OK ||
      length != sizeof(config) || config.magic != CONFIG_MAGIC ||
      config.version != STORAGE_VERSION) {
    memset(&config, 0, sizeof(config));
    config.magic = CONFIG_MAGIC;
    config.version = STORAGE_VERSION;
    snprintf(config.device_id, sizeof(config.device_id), "desk-panel");
  }
  nvs_close(handle);
}

static esp_err_t save_config(void) {
  nvs_handle_t handle;
  ESP_RETURN_ON_ERROR(open_storage(&handle), TAG, "Open NVS");
  esp_err_t result = nvs_set_blob(handle, "config", &config, sizeof(config));
  if (result == ESP_OK) result = nvs_commit(handle);
  nvs_close(handle);
  return result;
}

static void load_state(void) {
  memset(&state, 0, sizeof(state));
  nvs_handle_t handle;
  if (open_storage(&handle) == ESP_OK) {
    size_t length = sizeof(state);
    if (nvs_get_blob(handle, "state", &state, &length) != ESP_OK ||
        length != sizeof(state) || state.magic != STATE_MAGIC ||
        state.version != STORAGE_VERSION ||
        state.operation_count > MAX_PENDING_OPERATIONS) {
      memset(&state, 0, sizeof(state));
    }
    nvs_close(handle);
  }
  if (state.magic != STATE_MAGIC) {
    state.magic = STATE_MAGIC;
    state.version = STORAGE_VERSION;
    state.last_switch_state = SWITCH_INVALID;
  }
}

static esp_err_t save_state_locked(void) {
  nvs_handle_t handle;
  ESP_RETURN_ON_ERROR(open_storage(&handle), TAG, "Open NVS");
  esp_err_t result = nvs_set_blob(handle, "state", &state, sizeof(state));
  if (result == ESP_OK) result = nvs_commit(handle);
  nvs_close(handle);
  return result;
}

static bool config_complete(void) {
  return config.wifi_ssid[0] != '\0' && config.api_url[0] != '\0' &&
         strlen(config.wifi_ssid) <= 32 && strlen(config.wifi_password) <= 63 &&
         strncmp(config.api_url, "https://", 8) == 0 &&
         config.device_id[0] != '\0' && strlen(config.device_secret) >= 32 &&
         strlen(config.left_company_id) == 36 && strlen(config.right_company_id) == 36;
}

static void generate_uuid(char output[37]) {
  uint8_t bytes[16];
  esp_fill_random(bytes, sizeof(bytes));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  snprintf(output, 37,
           "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5],
           bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11],
           bytes[12], bytes[13], bytes[14], bytes[15]);
}

static bool append_operation_locked(operation_type_t type, const char *session_id,
                                    const char *company_id, time_t occurred_at) {
  if (state.operation_count >= MAX_PENDING_OPERATIONS) {
    ESP_LOGE(TAG, "Offline queue is full; switch change was not recorded");
    return false;
  }
  pending_operation_t *operation = &state.operations[state.operation_count++];
  memset(operation, 0, sizeof(*operation));
  operation->type = type;
  snprintf(operation->session_id, sizeof(operation->session_id), "%s", session_id);
  if (company_id) snprintf(operation->company_id, sizeof(operation->company_id), "%s", company_id);
  operation->occurred_at = (int64_t)occurred_at;
  return true;
}

static void apply_switch_state(switch_state_t next) {
  if (next == SWITCH_INVALID) {
    ESP_LOGW(TAG, "Ignoring electrically invalid switch state");
    return;
  }
  if (!clock_ready()) {
    ESP_LOGW(TAG, "Waiting for network time before recording switch changes");
    return;
  }

  xSemaphoreTake(state_mutex, portMAX_DELAY);
  const switch_state_t previous = (switch_state_t)state.last_switch_state;
  if (previous == next) {
    xSemaphoreGive(state_mutex);
    return;
  }

  const time_t occurred_at = time(NULL);
  persistent_state_t before = state;
  if (state.active_session_id[0] != '\0') {
    if (!append_operation_locked(OPERATION_STOP, state.active_session_id, NULL, occurred_at)) {
      state = before;
      xSemaphoreGive(state_mutex);
      return;
    }
    state.active_session_id[0] = '\0';
  }

  if (next == SWITCH_LEFT || next == SWITCH_RIGHT) {
    const char *company_id = next == SWITCH_LEFT ? config.left_company_id : config.right_company_id;
    char session_id[37];
    generate_uuid(session_id);
    if (!append_operation_locked(OPERATION_START, session_id, company_id, occurred_at)) {
      state = before;
      xSemaphoreGive(state_mutex);
      return;
    }
    snprintf(state.active_session_id, sizeof(state.active_session_id), "%s", session_id);
  }

  state.last_switch_state = (uint8_t)next;
  if (save_state_locked() != ESP_OK) {
    state = before;
    ESP_LOGE(TAG, "Could not persist switch change");
  } else {
    ESP_LOGI(TAG, "Recorded state=%s pending=%u", switch_state_name(next), state.operation_count);
  }
  xSemaphoreGive(state_mutex);
}

static void format_iso8601(int64_t epoch, char output[25]) {
  const time_t value = (time_t)epoch;
  struct tm utc;
  gmtime_r(&value, &utc);
  strftime(output, 25, "%Y-%m-%dT%H:%M:%SZ", &utc);
}

static void bytes_to_hex(const unsigned char *bytes, size_t length, char *output) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t index = 0; index < length; index++) {
    output[index * 2] = alphabet[bytes[index] >> 4];
    output[index * 2 + 1] = alphabet[bytes[index] & 0x0f];
  }
  output[length * 2] = '\0';
}

static bool sign_request(const char *timestamp, const char *method, const char *path,
                         const char *body, char signature[68]) {
  const mbedtls_md_info_t *sha256 = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!sha256) return false;

  unsigned char body_digest[32];
  if (mbedtls_md(sha256, (const unsigned char *)body, strlen(body), body_digest) != 0) return false;
  char body_hash[65];
  bytes_to_hex(body_digest, sizeof(body_digest), body_hash);

  char canonical[512];
  const int written = snprintf(canonical, sizeof(canonical), "%s\n%s\n%s\n%s",
                               timestamp, method, path, body_hash);
  if (written < 0 || written >= (int)sizeof(canonical)) return false;

  unsigned char digest[32];
  if (mbedtls_md_hmac(sha256, (const unsigned char *)config.device_secret,
                      strlen(config.device_secret), (const unsigned char *)canonical,
                      strlen(canonical), digest) != 0) {
    return false;
  }
  signature[0] = 'v';
  signature[1] = '1';
  signature[2] = '=';
  bytes_to_hex(digest, sizeof(digest), signature + 3);
  return true;
}

static bool send_operation(const pending_operation_t *operation) {
  char path[96];
  char occurred_at[25];
  char body[256];
  format_iso8601(operation->occurred_at, occurred_at);
  if (operation->type == OPERATION_START) {
    snprintf(path, sizeof(path), "/device/v1/sessions/start");
    snprintf(body, sizeof(body), "{\"id\":\"%s\",\"companyId\":\"%s\",\"startedAt\":\"%s\"}",
             operation->session_id, operation->company_id, occurred_at);
  } else {
    snprintf(path, sizeof(path), "/device/v1/sessions/%s/stop", operation->session_id);
    snprintf(body, sizeof(body), "{\"endedAt\":\"%s\"}", occurred_at);
  }

  char url[260];
  snprintf(url, sizeof(url), "%s%s", config.api_url, path);
  char timestamp[24];
  snprintf(timestamp, sizeof(timestamp), "%lld", (long long)time(NULL));
  char signature[68];
  if (!sign_request(timestamp, "POST", path, body, signature)) {
    ESP_LOGE(TAG, "Could not sign request");
    return false;
  }

  const esp_http_client_config_t http_config = {
      .url = url,
      .timeout_ms = 10000,
      .crt_bundle_attach = esp_crt_bundle_attach,
  };
  esp_http_client_handle_t client = esp_http_client_init(&http_config);
  if (!client) return false;
  esp_http_client_set_method(client, HTTP_METHOD_POST);
  esp_http_client_set_header(client, "Content-Type", "application/json");
  esp_http_client_set_header(client, "X-Time-Switch-Device", config.device_id);
  esp_http_client_set_header(client, "X-Time-Switch-Timestamp", timestamp);
  esp_http_client_set_header(client, "X-Time-Switch-Signature", signature);
  esp_http_client_set_post_field(client, body, strlen(body));

  const esp_err_t result = esp_http_client_perform(client);
  const int status = result == ESP_OK ? esp_http_client_get_status_code(client) : 0;
  esp_http_client_cleanup(client);
  if (result != ESP_OK) {
    ESP_LOGW(TAG, "Request failed: %s", esp_err_to_name(result));
    return false;
  }
  if (status < 200 || status >= 300) {
    ESP_LOGE(TAG, "Server rejected pending operation with HTTP %d", status);
    return false;
  }
  return true;
}

static void network_task(void *parameter) {
  (void)parameter;
  while (true) {
    const EventBits_t bits = xEventGroupGetBits(wifi_events);
    if ((bits & WIFI_CONNECTED_BIT) && clock_ready()) {
      if (!clock_was_ready) {
        clock_was_ready = true;
        ESP_LOGI(TAG, "Network time synchronized");
      }
      pending_operation_t operation;
      bool has_operation = false;
      xSemaphoreTake(state_mutex, portMAX_DELAY);
      if (state.operation_count > 0) {
        operation = state.operations[0];
        has_operation = true;
      }
      xSemaphoreGive(state_mutex);

      if (has_operation && send_operation(&operation)) {
        xSemaphoreTake(state_mutex, portMAX_DELAY);
        if (state.operation_count > 0 &&
            strcmp(state.operations[0].session_id, operation.session_id) == 0 &&
            state.operations[0].type == operation.type) {
          memmove(&state.operations[0], &state.operations[1],
                  sizeof(state.operations[0]) * (state.operation_count - 1));
          state.operation_count--;
          memset(&state.operations[state.operation_count], 0, sizeof(state.operations[0]));
          ESP_ERROR_CHECK_WITHOUT_ABORT(save_state_locked());
          ESP_LOGI(TAG, "Delivered pending operation; remaining=%u", state.operation_count);
        }
        xSemaphoreGive(state_mutex);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1500));
  }
}

static void switch_task(void *parameter) {
  (void)parameter;
  switch_state_t candidate = read_switch();
  switch_state_t stable = SWITCH_INVALID;
  unsigned matching_samples = 0;

  while (true) {
    const switch_state_t sample = read_switch();
    if (sample == candidate) {
      if (matching_samples < DEBOUNCE_SAMPLES) matching_samples++;
    } else {
      candidate = sample;
      matching_samples = 1;
    }
    if (matching_samples >= DEBOUNCE_SAMPLES && candidate != stable) {
      stable = candidate;
      ESP_LOGI(TAG, "Switch position=%s gpio3=%d gpio4=%d", switch_state_name(stable),
               gpio_get_level(SWITCH_LEFT_GPIO), gpio_get_level(SWITCH_RIGHT_GPIO));
    }
    if (stable != SWITCH_INVALID && clock_ready() &&
        stable != (switch_state_t)state.last_switch_state) {
      apply_switch_state(stable);
    }
    vTaskDelay(pdMS_TO_TICKS(SAMPLE_INTERVAL_MS));
  }
}

static void wifi_event_handler(void *argument, esp_event_base_t base,
                               int32_t event_id, void *event_data) {
  (void)argument;
  (void)event_data;
  if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
  } else if (base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
    xEventGroupClearBits(wifi_events, WIFI_CONNECTED_BIT);
    esp_wifi_connect();
  } else if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
    xEventGroupSetBits(wifi_events, WIFI_CONNECTED_BIT);
    ESP_LOGI(TAG, "Wi-Fi connected");
  }
}

static void start_wifi(void) {
  wifi_events = xEventGroupCreate();
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t initialization = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&initialization));
  ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL));

  wifi_config_t wifi_config = {0};
  memcpy(wifi_config.sta.ssid, config.wifi_ssid, strlen(config.wifi_ssid));
  memcpy(wifi_config.sta.password, config.wifi_password, strlen(config.wifi_password));
  wifi_config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
  wifi_config.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
  ESP_ERROR_CHECK(esp_wifi_start());

  esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
  esp_sntp_setservername(0, "time.cloudflare.com");
  esp_sntp_init();
}

static bool set_config_value(const char *key, const char *value) {
#define SET_VALUE(name, field) \
  if (strcmp(key, name) == 0) { \
    if (strlen(value) >= sizeof(config.field)) return false; \
    snprintf(config.field, sizeof(config.field), "%s", value); \
    return true; \
  }
  SET_VALUE("wifi_ssid", wifi_ssid)
  SET_VALUE("wifi_password", wifi_password)
  SET_VALUE("api_url", api_url)
  SET_VALUE("device_id", device_id)
  SET_VALUE("device_secret", device_secret)
  SET_VALUE("left_company_id", left_company_id)
  SET_VALUE("right_company_id", right_company_id)
#undef SET_VALUE
  return false;
}

static void print_config(void) {
  printf("\nTime Switch configuration\n");
  printf("  wifi_ssid: %s\n", config.wifi_ssid[0] ? config.wifi_ssid : "<unset>");
  printf("  wifi_password: %s\n", config.wifi_password[0] ? "<stored>" : "<unset>");
  printf("  api_url: %s\n", config.api_url[0] ? config.api_url : "<unset>");
  printf("  device_id: %s\n", config.device_id[0] ? config.device_id : "<unset>");
  printf("  device_secret: %s\n", config.device_secret[0] ? "<stored>" : "<unset>");
  printf("  left_company_id: %s\n", config.left_company_id[0] ? config.left_company_id : "<unset>");
  printf("  right_company_id: %s\n", config.right_company_id[0] ? config.right_company_id : "<unset>");
  printf("  complete: %s\n", config_complete() ? "yes" : "no");
  printf("Commands: show | set <key> <value> | reboot | clear_state\n\n");
}

static void console_task(void *parameter) {
  (void)parameter;
  char line[256];
  print_config();
  while (fgets(line, sizeof(line), stdin)) {
    line[strcspn(line, "\r\n")] = '\0';
    if (strcmp(line, "show") == 0) {
      print_config();
    } else if (strcmp(line, "reboot") == 0) {
      printf("Rebooting…\n");
      fflush(stdout);
      esp_restart();
    } else if (strcmp(line, "clear_state") == 0) {
      xSemaphoreTake(state_mutex, portMAX_DELAY);
      memset(&state, 0, sizeof(state));
      state.magic = STATE_MAGIC;
      state.version = STORAGE_VERSION;
      state.last_switch_state = SWITCH_INVALID;
      ESP_ERROR_CHECK_WITHOUT_ABORT(save_state_locked());
      xSemaphoreGive(state_mutex);
      printf("Runtime state and offline queue cleared.\n");
    } else if (strncmp(line, "set ", 4) == 0) {
      char *key = line + 4;
      char *value = strchr(key, ' ');
      if (!value) {
        printf("Usage: set <key> <value>\n");
        continue;
      }
      *value++ = '\0';
      while (*value == ' ') value++;
      if (!set_config_value(key, value)) {
        printf("Unknown key or value is too long.\n");
      } else if (save_config() != ESP_OK) {
        printf("Could not save configuration.\n");
      } else {
        printf("Saved %s. Reboot after completing configuration.\n", key);
      }
    } else if (line[0] != '\0') {
      printf("Unknown command. Type show for help.\n");
    }
    printf("> ");
    fflush(stdout);
  }
  vTaskDelete(NULL);
}

void app_main(void) {
  esp_err_t result = nvs_flash_init();
  if (result == ESP_ERR_NVS_NO_FREE_PAGES || result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    result = nvs_flash_init();
  }
  ESP_ERROR_CHECK(result);
  load_config();
  load_state();
  state_mutex = xSemaphoreCreateMutex();

  const gpio_config_t input_config = {
      .pin_bit_mask = (1ULL << SWITCH_LEFT_GPIO) | (1ULL << SWITCH_RIGHT_GPIO),
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  ESP_ERROR_CHECK(gpio_config(&input_config));
  xTaskCreate(console_task, "console", 4096, NULL, 4, NULL);

  ESP_LOGI(TAG, "Time Switch starting; left=GPIO3 right=GPIO4");
  if (!config_complete()) {
    ESP_LOGW(TAG, "Configuration is incomplete; use the USB console and reboot when finished");
    while (true) vTaskDelay(pdMS_TO_TICKS(1000));
  }

  start_wifi();
  xTaskCreate(network_task, "network", 8192, NULL, 5, NULL);
  xTaskCreate(switch_task, "switch", 4096, NULL, 6, NULL);
}
