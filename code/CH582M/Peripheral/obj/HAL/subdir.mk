################################################################################
# MRS Version: 2.5.0
# Automatically-generated file. Do not edit!
################################################################################

# Add inputs and outputs from these tool invocations to the build variables 
C_SRCS += \
../HAL/MCU.c \
../HAL/RTC.c \
../HAL/SLEEP.c 

C_DEPS += \
./HAL/MCU.d \
./HAL/RTC.d \
./HAL/SLEEP.d 

OBJS += \
./HAL/MCU.o \
./HAL/RTC.o \
./HAL/SLEEP.o 

DIR_OBJS += \
./HAL/*.o \

DIR_DEPS += \
./HAL/*.d \

DIR_EXPANDS += \
./HAL/*.234r.expand \


# Each subdirectory must supply rules for building sources it contributes
HAL/%.o: ../HAL/%.c
	@	riscv-none-embed-gcc -march=rv32imac -mabi=ilp32 -mcmodel=medany -msmall-data-limit=8 -mno-save-restore -fmax-errors=20 -Os -fmessage-length=0 -fsigned-char -ffunction-sections -fdata-sections -fno-common -g -DDEBUG=1 -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/Startup" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/APP/include" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/Profile/include" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/StdPeriphDriver/inc" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/HAL/include" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/Ld" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/LIB" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/RVMSIS" -std=gnu99 -MMD -MP -MF"$(@:%.o=%.d)" -MT"$(@)" -c -o "$@" "$<"

