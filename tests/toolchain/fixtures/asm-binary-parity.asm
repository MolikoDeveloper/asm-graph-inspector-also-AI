bits 64

global _start

section .text
_start:
    mov eax, 1
    mov edi, 1
    mov rsi, message
    mov edx, 16
    syscall

    mov eax, 60
    xor edi, edi
    syscall

section .data
message: db "hello from nasm", 10
