################################################################################
# MRS Version: 2.5.0
# Automatically-generated file. Do not edit!
################################################################################

# Add inputs and outputs from these tool invocations to the build variables 
C_SRCS += \
../Profile/devinfoservice.c \
../Profile/gattprofile.c 

C_DEPS += \
./Profile/devinfoservice.d \
./Profile/gattprofile.d 

OBJS += \
./Profile/devinfoservice.o \
./Profile/gattprofile.o 

DIR_OBJS += \
./Profile/*.o \

DIR_DEPS += \
./Profile/*.d \

DIR_EXPANDS += \
./Profile/*.234r.expand \


# Each subdirectory must supply rules for building sources it contributes
Profile/%.o: ../Profile/%.c
	@	riscv-none-embed-gcc -march=rv32imac -mabi=ilp32 -mcmodel=medany -msmall-data-limit=8 -mno-save-restore -fmax-errors=20 -Os -fmessage-length=0 -fsigned-char -ffunction-sections -fdata-sections -fno-common -g -DDEBUG=1 -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/Startup" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/APP/include" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/Profile/include" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/StdPeriphDriver/inc" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/HAL/include" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/Ld" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/LIB" -I"d:/WorkSpace/Code/Proj/Keygo/code/CH582M/Peripheral/RVMSIS" -std=gnu99 -MMD -MP -MF"$(@:%.o=%.d)" -MT"$(@)" -c -o "$@" "$<"

