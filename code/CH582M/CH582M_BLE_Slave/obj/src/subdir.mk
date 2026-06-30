################################################################################
# MRS Version: 2.5.0
# Automatically-generated file. Do not edit!
################################################################################

# Add inputs and outputs from these tool invocations to the build variables 
C_SRCS += \
../src/Main.c \
../src/peripheral.c 

C_DEPS += \
./src/Main.d \
./src/peripheral.d 

OBJS += \
./src/Main.o \
./src/peripheral.o 

DIR_OBJS += \
./src/*.o \

DIR_DEPS += \
./src/*.d \

DIR_EXPANDS += \
./src/*.234r.expand \


# Each subdirectory must supply rules for building sources it contributes
src/%.o: ../src/%.c
	@	riscv-none-embed-gcc -march=rv32imac -mabi=ilp32 -mcmodel=medany -msmall-data-limit=8 -mno-save-restore -fmax-errors=20 -Os -fmessage-length=0 -fsigned-char -ffunction-sections -fdata-sections -fno-common -g -DDEBUG=1 -I"d:\WorkSpace\Code\Proj\Keygo\code\CH582M\CH582M_BLE_Slave\StdPeriphDriver\inc" -I"d:\WorkSpace\Code\Proj\Keygo\code\CH582M\CH582M_BLE_Slave\RVMSIS" -std=gnu99 -MMD -MP -MF"$(@:%.o=%.d)" -MT"$(@)" -c -o "$@" "$<"

