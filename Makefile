# Instrufilt build.
#
#   make               build wasm/build/vocal_isolate.wasm  (needs emscripten)
#   make test-native   DSP assertions via gcc                (no emscripten)
#   make test          everything: native + node suites + vendoring
#   make clean
#
# The .wasm artifact is committed, so contributors only need emscripten if they
# touch the DSP. `make test-native` compiles the same C with gcc and asserts on
# the numbers directly — it is the fast loop, and it catches everything that
# matters about the DSP without emscripten in the way.

EMCC      = emcc
CC        = gcc
WASM_SRC  = wasm/src
WASM_TEST = wasm/test
WASM_OUT  = wasm/build
BUILD     = build

WASM_TARGET = $(WASM_OUT)/vocal_isolate.wasm

# chroma.c arrives in the chord-detection phase. Until then the build and the
# native tests degrade to the isolation half rather than failing outright, so
# `make test-native` stays useful throughout.
CHROMA_C    := $(wildcard $(WASM_SRC)/chroma.c)
CHROMA_TEST := $(wildcard $(WASM_TEST)/chroma_test.c)

DSP_SRCS = $(WASM_SRC)/vocal_isolate_stft.c \
           $(CHROMA_C) \
           $(WASM_SRC)/kiss_fft.c \
           $(WASM_SRC)/kiss_fftr.c

# Kept in one place so the Makefile and worklet-processor.js cannot drift.
# emcc errors on an exported symbol that does not exist, so the chroma half is
# only appended once chroma.c is actually present.
ISO_EXPORTS = \
\"_isolate_init\",\
\"_isolate_process\",\
\"_isolate_cleanup\",\
\"_isolate_get_input_l\",\
\"_isolate_get_input_r\",\
\"_isolate_get_output_l\",\
\"_isolate_get_output_r\",\
\"_isolate_set_amount\",\
\"_isolate_set_mode\",\
\"_isolate_set_makeup_db\",\
\"_isolate_set_auto_gain\",\
\"_isolate_set_mono\",\
\"_isolate_set_repet\",\
\"_isolate_repet_reset\",\
\"_isolate_get_flux\",\
\"_isolate_latency_samples\"

CHROMA_EXPORTS = \
\"_chroma_init\",\
\"_chroma_enable\",\
\"_chroma_reset\",\
\"_chroma_feed\",\
\"_chroma_pop_frame\",\
\"_chroma_get_frame_ptr\",\
\"_chroma_pop_event\",\
\"_chroma_get_event_ptr\",\
\"_chroma_get_tuning\"

EXPORTS = "EXPORTED_FUNCTIONS=[$(ISO_EXPORTS),$(if $(CHROMA_C),$(CHROMA_EXPORTS)$(comma))\"_malloc\",\"_free\"]"
comma := ,

.PHONY: all build test test-native test-node test-vendor clean

all: build

build: $(WASM_TARGET)

$(WASM_TARGET): $(DSP_SRCS) $(WASM_SRC)/isolate.h $(wildcard $(WASM_SRC)/chroma.h)
	mkdir -p $(WASM_OUT)
	$(EMCC) \
		$(WASM_SRC)/vocal_isolate_stft.c \
		$(CHROMA_C) \
		$(WASM_SRC)/kiss_fft.c \
		$(WASM_SRC)/kiss_fftr.c \
		-I$(WASM_SRC) \
		-O3 \
		-msimd128 \
		--no-entry \
		-lm \
		-s WASM=1 \
		-s $(EXPORTS) \
		-s ALLOW_MEMORY_GROWTH=0 \
		-s INITIAL_MEMORY=8388608 \
		-s TOTAL_STACK=262144 \
		-o $(WASM_TARGET)
	@echo "built $(WASM_TARGET)"

# ALLOW_MEMORY_GROWTH=0 is load-bearing, not incidental. worklet-processor.js
# builds its Float32Array views over the WASM heap exactly once; if the heap
# ever grew, every view would detach and the worklet would silently emit
# garbage with no error anywhere. Raise INITIAL_MEMORY instead of enabling
# growth. The chroma stage is why 4 MB (Karafilt's figure) is not enough:
# an 8192-point FFT config, the rolling analysis buffer, and the per-bin mask
# and magnitude state.

# ---------------------------------------------------------------- tests

test: test-native test-vendor test-node
	@echo ""
	@echo "all tests passed"

NATIVE_TESTS = $(BUILD)/iso_test $(if $(CHROMA_TEST),$(BUILD)/chroma_test)

test-native: $(NATIVE_TESTS)
	@echo ""
	@echo "== DSP =="
	@./$(BUILD)/iso_test
ifneq ($(CHROMA_TEST),)
	@echo ""
	@echo "== chroma =="
	@./$(BUILD)/chroma_test
else
	@echo ""
	@echo "-- chroma tests: not yet present (chord detection phase)"
endif

$(BUILD)/iso_test: $(WASM_TEST)/iso_test.c $(WASM_SRC)/vocal_isolate_stft.c $(WASM_SRC)/isolate.h
	@mkdir -p $(BUILD)
	$(CC) -O2 -I$(WASM_SRC) $(WASM_TEST)/iso_test.c \
		$(WASM_SRC)/vocal_isolate_stft.c \
		$(WASM_SRC)/kiss_fft.c $(WASM_SRC)/kiss_fftr.c \
		-lm -o $@

$(BUILD)/chroma_test: $(WASM_TEST)/chroma_test.c $(WASM_SRC)/chroma.c $(WASM_SRC)/chroma.h
	@mkdir -p $(BUILD)
	$(CC) -O2 -I$(WASM_SRC) $(WASM_TEST)/chroma_test.c \
		$(WASM_SRC)/chroma.c \
		$(WASM_SRC)/vocal_isolate_stft.c \
		$(WASM_SRC)/kiss_fft.c $(WASM_SRC)/kiss_fftr.c \
		-lm -o $@

test-vendor:
	@echo ""
	@echo "== vendoring =="
	@node test/vendor-drift.test.mjs

test-node:
	@echo ""
	@echo "== node suites =="
	@for t in test/*.test.mjs; do \
		case "$$t" in *vendor-drift*) continue;; esac; \
		echo "-- $$t"; node "$$t" || exit 1; \
	done

clean:
	rm -rf $(BUILD) $(WASM_OUT)/*.wasm dist
