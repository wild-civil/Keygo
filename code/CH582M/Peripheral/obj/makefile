################################################################################
# MRS Version: 2.5.0
# Automatically-generated file. Do not edit!
################################################################################
-include ../makefile.init

RM := rm -rf

# All of the sources participating in the build are defined here
-include sources.mk
-include StdPeriphDriver/subdir.mk
-include Startup/subdir.mk
-include RVMSIS/subdir.mk
-include Profile/subdir.mk
-include HAL/subdir.mk
-include APP/subdir.mk
-include subdir.mk
-include objects.mk

ifneq ($(MAKECMDGOALS),clean)
ifneq ($(strip $(S_DEPS)),)
-include $(S_DEPS)
endif
ifneq ($(strip $(S_UPPER_DEPS)),)
-include $(S_UPPER_DEPS)
endif
ifneq ($(strip $(ASM_DEPS)),)
-include $(ASM_DEPS)
endif
ifneq ($(strip $(ASM_UPPER_DEPS)),)
-include $(ASM_UPPER_DEPS)
endif
ifneq ($(strip $(C_DEPS)),)
-include $(C_DEPS)
endif
endif

-include ../makefile.defs

# Add inputs and outputs from these tool invocations to the build variables 
SECONDARY_FLASH += \
Peripheral.hex \

SECONDARY_LIST += \
Peripheral.lst \

SECONDARY_SIZE += \
Peripheral.siz \


# All Target
all: 
	$(MAKE) --no-print-directory main-build 

main-build: Peripheral.elf secondary-outputs

# Tool invocations
Peripheral.elf: $(OBJS) $(USER_OBJS_ESCAPE)
	@	riscv-none-embed-gcc -march=rv32imac -mabi=ilp32 -mcmodel=medany -msmall-data-limit=8 -mno-save-restore -fmax-errors=20 -Os -fmessage-length=0 -fsigned-char -ffunction-sections -fdata-sections -fno-common -g -T "d:\WorkSpace\Code\Proj\Keygo\code\CH582M\Peripheral\Ld\Link.ld" -nostartfiles -Xlinker --gc-sections -L"d:\WorkSpace\Code\Proj\Keygo\code\CH582M\Peripheral" -L"d:\WorkSpace\Code\Proj\Keygo\code\CH582M\Peripheral\LIB" -L"d:\WorkSpace\Code\Proj\Keygo\code\CH582M\Peripheral\StdPeriphDriver" -Xlinker --print-memory-usage -Wl,-Map,"Peripheral.map" --specs=nano.specs --specs=nosys.specs -o "Peripheral.elf" $(OBJS) $(LIBS)
Peripheral.hex: Peripheral.elf
	@	riscv-none-embed-objcopy -O ihex "Peripheral.elf" "Peripheral.hex"
Peripheral.lst: Peripheral.elf
	@	riscv-none-embed-objdump --source --all-headers --demangle --line-numbers --wide "Peripheral.elf" > "Peripheral.lst"
Peripheral.siz: Peripheral.elf
	riscv-none-embed-size --format=berkeley "Peripheral.elf"

# Other Targets
clean:
	-$(RM) $(DIR_OBJS) $(SECONDARY_FLASH)$(SECONDARY_LIST)$(SECONDARY_SIZE) Peripheral.elf
	-$(RM) $(DIR_EXPANDS) $(CALLGRAPH_DOT)
	-$(RM) $(DIR_DEPS)
secondary-outputs: $(SECONDARY_FLASH) $(SECONDARY_LIST) $(SECONDARY_SIZE)

.PHONY: all clean dependents

-include ../makefile.targets