.PHONY: help
help: ## Show help
	@echo top-level help

%.o: %.c
	@echo pattern compile rule, not a catch-all

%:
	@$(MAKE) -C $(SUBDIR) $@
