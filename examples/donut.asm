bits 64
global _start

section .data
frame0:
    db 27, '[2J', 27, '[H'
    db '              .-========-.', 10
    db '          .-==oooooooooooo==-.', 10
    db '       .==oooOOOOOOOOOOOOooo==.', 10
    db '     .==ooOO@@@OOOOOOOO@@@OOoo==.', 10
    db '    ==ooOO@@OOoo......ooOO@@OOoo==', 10
    db '   =ooOO@OOo..          ..oOO@OOoo=', 10
    db '   =ooOO@OOo..   DONUT    ..oOO@OOoo=', 10
    db '    ==ooOO@@OOoo......ooOO@@OOoo==', 10
    db '     .==ooOO@@@OOOOOOOO@@@OOoo==.', 10
    db '       .==oooOOOOOOOOOOOOooo==.', 10
    db '          .-==oooooooooooo==-.', 10
    db '              .-========-.', 10
    db '                 phase /', 10
frame0_len equ $ - frame0

frame1:
    db 27, '[2J', 27, '[H'
    db '              .-========-.', 10
    db '          .-==OOOOoooooooo==-.', 10
    db '       .==OOO@@OOOOOOOOOooo==.', 10
    db '     .==OO@@OOooOOOOOOOOOOOoo==.', 10
    db '    ==OO@@OOoo......ooOOOOOOoo==', 10
    db '   =OO@OOo..          ..ooOOOOoo=', 10
    db '   =OO@OOo..   DONUT    ..ooOOOOoo=', 10
    db '    ==OO@@OOoo......ooOOOOOOoo==', 10
    db '     .==OO@@OOooOOOOOOOOOOOoo==.', 10
    db '       .==OOO@@OOOOOOOOOooo==.', 10
    db '          .-==OOOOoooooooo==-.', 10
    db '              .-========-.', 10
    db '                 phase -', 10
frame1_len equ $ - frame1

frame2:
    db 27, '[2J', 27, '[H'
    db '              .-========-.', 10
    db '          .-==ooooooooOOOO==-.', 10
    db '       .==oooOOOOOOOOO@@OOO==.', 10
    db '     .==ooOOOOOOOOOOOooOO@@OO==.', 10
    db '    ==ooOOOOOOoo......ooOO@@OO==', 10
    db '   =ooOOOOoo..          ..oOO@OO=', 10
    db '   =ooOOOOoo..   DONUT    ..oOO@OO=', 10
    db '    ==ooOOOOOOoo......ooOO@@OO==', 10
    db '     .==ooOOOOOOOOOOOooOO@@OO==.', 10
    db '       .==oooOOOOOOOOO@@OOO==.', 10
    db '          .-==ooooooooOOOO==-.', 10
    db '              .-========-.', 10
    db '                 phase \\', 10
frame2_len equ $ - frame2

frame3:
    db 27, '[2J', 27, '[H'
    db '              .-========-.', 10
    db '          .-==ooooOOOOoooo==-.', 10
    db '       .==ooOO@@OOOO@@OOoo==.', 10
    db '     .==oOO@@OOooooOO@@OOo==.', 10
    db '    ==oOO@OOoo......ooOO@OOo==', 10
    db '   =oOO@OOo..          ..oOO@OOo=', 10
    db '   =oOO@OOo..   DONUT    ..oOO@OOo=', 10
    db '    ==oOO@OOoo......ooOO@OOo==', 10
    db '     .==oOO@@OOooooOO@@OOo==.', 10
    db '       .==ooOO@@OOOO@@OOoo==.', 10
    db '          .-==ooooOOOOoooo==-.', 10
    db '              .-========-.', 10
    db '                 phase |', 10
frame3_len equ $ - frame3

%macro SHOW_FRAME 2
    mov eax, 1
    mov edi, 1
    lea rsi, [rel %1]
    mov edx, %2
    syscall
    mov ecx, 4000
%%delay:
    dec ecx
    jnz %%delay
%endmacro

section .text
_start:
    mov r12d, 4
.spin:
    SHOW_FRAME frame0, frame0_len
    SHOW_FRAME frame1, frame1_len
    SHOW_FRAME frame2, frame2_len
    SHOW_FRAME frame3, frame3_len
    dec r12d
    jnz .spin

    mov eax, 60
    xor edi, edi
    syscall
